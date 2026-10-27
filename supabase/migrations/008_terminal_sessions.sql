-- Migration: 008_terminal_sessions.sql
-- Description: Authenticated remote terminal sessions, ordered command/output
--              streams, bounded output buffers and device lifecycle RPCs.
--
-- Transport contract
-- ------------------
-- * The browser never talks to the agent. It opens/uses a session through the
--   dashboard server, which enforces org-scoped administrator authorization.
-- * The Windows agent holds a long-poll request open on `agent-gateway`; commands
--   are delivered as soon as they are inserted (not on a periodic job interval),
--   and output is pushed back in ordered batches.
-- * Every record is scoped by (organization_id, device_id, session_id); the agent
--   can only read/write sessions belonging to its own authenticated device.
--
-- A session is single-target and single-agent:
--   pending -> active -> closed | expired | revoked
--   pending/active sessions are superseded by a new session on the same device.

CREATE TYPE terminal_session_state AS ENUM ('pending', 'active', 'closed', 'expired', 'revoked');

CREATE TABLE terminal_sessions (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id       UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    device_id             UUID NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    created_by            UUID NOT NULL REFERENCES auth.users (id),
    status                terminal_session_state NOT NULL DEFAULT 'pending',
    -- Hostname snapshot taken when the session is opened, so the operator can
    -- always see which machine they are attached to even after renames.
    hostname_snapshot     TEXT CHECK (char_length(hostname_snapshot) <= 253),
    -- Reason for close/expiry/revocation, shown in the terminal UI.
    close_reason          TEXT CHECK (char_length(close_reason) <= 500),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_at          TIMESTAMPTZ,
    last_activity_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at             TIMESTAMPTZ,
    expires_at            TIMESTAMPTZ NOT NULL,
    agent_instance_id     TEXT CHECK (char_length(agent_instance_id) <= 64),
    -- Monotonic per-session sequence counters (created under row lock).
    last_command_sequence BIGINT NOT NULL DEFAULT 0,
    last_output_sequence  BIGINT NOT NULL DEFAULT 0,
    client_ip             INET,
    CONSTRAINT chk_terminal_expiry CHECK (expires_at > created_at),
    CONSTRAINT chk_terminal_closed CHECK (
        (status IN ('pending', 'active') AND closed_at IS NULL)
        OR (status IN ('closed', 'expired', 'revoked') AND closed_at IS NOT NULL)
    )
);

CREATE INDEX idx_terminal_sessions_org    ON terminal_sessions (organization_id, created_at DESC);
CREATE INDEX idx_terminal_sessions_device ON terminal_sessions (device_id, created_at DESC);
CREATE INDEX idx_terminal_sessions_open   ON terminal_sessions (device_id, status)
    WHERE status IN ('pending', 'active');

CREATE TABLE terminal_commands (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id    UUID NOT NULL REFERENCES terminal_sessions (id) ON DELETE CASCADE,
    sequence      BIGINT NOT NULL,
    command       TEXT NOT NULL CHECK (char_length(command) BETWEEN 1 AND 16384),
    created_by    UUID REFERENCES auth.users (id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at  TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ,
    exit_ok       BOOLEAN,
    error_summary TEXT CHECK (char_length(error_summary) <= 1000),
    UNIQUE (session_id, sequence)
);

CREATE INDEX idx_terminal_commands_session ON terminal_commands (session_id, sequence);

CREATE TABLE terminal_output (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES terminal_sessions (id) ON DELETE CASCADE,
    sequence   BIGINT NOT NULL,
    stream     TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'system')),
    content    TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 8192),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, sequence)
);

CREATE INDEX idx_terminal_output_session ON terminal_output (session_id, sequence);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE terminal_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE terminal_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE terminal_output   ENABLE ROW LEVEL SECURITY;

CREATE POLICY terminal_sessions_select_admin ON terminal_sessions
    FOR SELECT TO authenticated
    USING (
        NOT auth_is_device()
        AND auth_has_role(organization_id, 'administrator')
    );

CREATE POLICY terminal_commands_select_admin ON terminal_commands
    FOR SELECT TO authenticated
    USING (
        NOT auth_is_device()
        AND EXISTS (
            SELECT 1 FROM terminal_sessions s
            WHERE s.id = terminal_commands.session_id
              AND auth_has_role(s.organization_id, 'administrator')
        )
    );

CREATE POLICY terminal_output_select_admin ON terminal_output
    FOR SELECT TO authenticated
    USING (
        NOT auth_is_device()
        AND EXISTS (
            SELECT 1 FROM terminal_sessions s
            WHERE s.id = terminal_output.session_id
              AND auth_has_role(s.organization_id, 'administrator')
        )
    );

-- All writes go through the RPCs below, which are executable only by the
-- service role used by the dashboard server and the agent gateway. There are no
-- direct INSERT/UPDATE/DELETE policies for application roles.

-- ============================================================
-- HELPER: verify an actor is an organization administrator
-- ============================================================
CREATE OR REPLACE FUNCTION terminal_actor_is_admin(p_org_id UUID, p_actor UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM organization_members
        WHERE organization_id = p_org_id
          AND user_id = p_actor
          AND role IN ('owner', 'administrator')
    );
$$;

-- ============================================================
-- CREATE SESSION (dashboard server, on behalf of an administrator)
-- ============================================================
CREATE OR REPLACE FUNCTION terminal_create_session(
    p_device_id UUID,
    p_actor     UUID,
    p_client_ip INET DEFAULT NULL
)
RETURNS TABLE (session_id UUID, expires_at TIMESTAMPTZ, hostname TEXT, organization_id UUID)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_device   devices;
    v_max_secs INT;
    v_session  terminal_sessions;
BEGIN
    SELECT * INTO v_device FROM devices WHERE id = p_device_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'device_not_found';
    END IF;

    IF NOT terminal_actor_is_admin(v_device.organization_id, p_actor) THEN
        RAISE EXCEPTION 'forbidden';
    END IF;

    IF v_device.enrollment_status <> 'enrolled' THEN
        RAISE EXCEPTION 'device_not_authorized';
    END IF;

    SELECT COALESCE(terminal_max_secs, 3600) INTO v_max_secs
    FROM organization_settings
    WHERE organization_settings.organization_id = v_device.organization_id;

    v_max_secs := COALESCE(v_max_secs, 3600);

    -- Single active session per device: terminate older open sessions.
    UPDATE terminal_sessions SET
        status       = 'closed',
        close_reason = 'Superseded by a new terminal session',
        closed_at    = now()
    WHERE device_id = p_device_id
      AND status IN ('pending', 'active');

    INSERT INTO terminal_sessions (
        organization_id, device_id, created_by, hostname_snapshot,
        status, expires_at, client_ip
    ) VALUES (
        v_device.organization_id, p_device_id, p_actor, v_device.hostname,
        'pending', now() + make_interval(secs => v_max_secs), p_client_ip
    )
    RETURNING * INTO v_session;

    INSERT INTO audit_events (organization_id, actor_type, actor_id, action,
                              target_type, target_id, metadata, ip_address)
    VALUES (v_device.organization_id, 'user', p_actor, 'terminal.session_created',
            'terminal_session', v_session.id,
            jsonb_build_object('device_id', p_device_id, 'hostname', v_device.hostname,
                               'expires_at', v_session.expires_at),
            p_client_ip);

    RETURN QUERY SELECT v_session.id, v_session.expires_at,
                        v_device.hostname, v_device.organization_id;
END;
$$;

-- ============================================================
-- AGENT CLAIM (agent picks up a session opened for its device)
-- ============================================================
CREATE OR REPLACE FUNCTION terminal_agent_claim(
    p_device_id     UUID,
    p_agent_instance TEXT DEFAULT NULL
)
RETURNS TABLE (
    session_id            UUID,
    expires_at            TIMESTAMPTZ,
    last_output_sequence  BIGINT,
    hostname              TEXT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session terminal_sessions;
    v_device  devices;
BEGIN
    SELECT * INTO v_device FROM devices WHERE id = p_device_id;
    IF NOT FOUND OR v_device.enrollment_status <> 'enrolled' THEN
        RETURN;
    END IF;

    -- Expire sessions that outlived their lifetime before claiming.
    UPDATE terminal_sessions SET status = 'expired', closed_at = now(),
                                 close_reason = 'Session lifetime exceeded'
    WHERE terminal_sessions.device_id = p_device_id
      AND terminal_sessions.status IN ('pending', 'active')
      AND terminal_sessions.expires_at <= now();

    SELECT * INTO v_session
    FROM terminal_sessions
    WHERE terminal_sessions.device_id = p_device_id
      AND terminal_sessions.status = 'pending'
      AND terminal_sessions.expires_at > now()
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    -- When a new session is being claimed, close any older active sessions for this device
    UPDATE terminal_sessions SET status = 'closed', closed_at = now(),
                                 close_reason = 'Agent reconnected; previous session ended'
    WHERE terminal_sessions.device_id = p_device_id
      AND terminal_sessions.status = 'active'
      AND id <> v_session.id;

    UPDATE terminal_sessions SET
        status            = 'active',
        activated_at      = now(),
        last_activity_at  = now(),
        agent_instance_id = LEFT(COALESCE(p_agent_instance, ''), 64)
    WHERE id = v_session.id
    RETURNING * INTO v_session;

    UPDATE devices SET last_session_at = now(), updated_at = now() WHERE id = p_device_id;

    INSERT INTO audit_events (organization_id, actor_type, actor_id, action,
                              target_type, target_id, metadata)
    VALUES (v_session.organization_id, 'device', p_device_id, 'terminal.session_activated',
            'terminal_session', v_session.id,
            jsonb_build_object('agent_instance_id', v_session.agent_instance_id));

    RETURN QUERY SELECT v_session.id, v_session.expires_at,
                        v_session.last_output_sequence,
                        COALESCE(v_session.hostname_snapshot, v_device.hostname);
END;
$$;

-- ============================================================
-- AGENT POLL (long-polled by the agent; returns undelivered commands)
-- ============================================================
CREATE OR REPLACE FUNCTION terminal_agent_poll(
    p_session_id UUID,
    p_device_id  UUID
)
RETURNS TABLE (
    session_status   TEXT,
    close_reason     TEXT,
    command_id       UUID,
    command_sequence BIGINT,
    command          TEXT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session terminal_sessions;
    v_cmd     terminal_commands;
    v_count   INT := 0;
BEGIN
    SELECT * INTO v_session
    FROM terminal_sessions
    WHERE id = p_session_id AND device_id = p_device_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'invalid'::TEXT, NULL::TEXT, NULL::UUID, NULL::BIGINT, NULL::TEXT;
        RETURN;
    END IF;

    IF v_session.status IN ('pending', 'active') AND v_session.expires_at <= now() THEN
        UPDATE terminal_sessions SET status = 'expired', closed_at = now(),
                                    close_reason = 'Session lifetime exceeded'
        WHERE id = p_session_id
        RETURNING * INTO v_session;
    END IF;

    -- NOTE: polling must NOT refresh last_activity_at, otherwise an attached but
    -- idle agent would keep an abandoned session alive forever. Activity is
    -- refreshed when a command is delivered or output is produced.
    FOR v_cmd IN
        SELECT * FROM terminal_commands
        WHERE session_id = p_session_id
          AND delivered_at IS NULL
        ORDER BY sequence ASC
        LIMIT 25
    LOOP
        UPDATE terminal_commands SET delivered_at = now() WHERE id = v_cmd.id;
        IF v_count = 0 THEN
            UPDATE terminal_sessions SET last_activity_at = now() WHERE id = p_session_id;
        END IF;
        v_count := v_count + 1;
        RETURN QUERY SELECT v_session.status::TEXT, v_session.close_reason,
                            v_cmd.id, v_cmd.sequence, v_cmd.command;
    END LOOP;

    IF v_count = 0 THEN
        RETURN QUERY SELECT v_session.status::TEXT, v_session.close_reason,
                            NULL::UUID, NULL::BIGINT, NULL::TEXT;
    END IF;
END;
$$;

-- ============================================================
-- AGENT OUTPUT APPEND (ordered batches, bounded buffer)
-- ============================================================
CREATE OR REPLACE FUNCTION terminal_agent_append_output(
    p_session_id UUID,
    p_device_id  UUID,
    p_items      JSONB
)
RETURNS TABLE (session_status TEXT, last_output_sequence BIGINT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session  terminal_sessions;
    v_seq      BIGINT;
    v_item     JSONB;
    v_stream   TEXT;
    v_content  TEXT;
    v_keep     INT;
    v_buffer   INT;
    v_org_id   UUID;
BEGIN
    SELECT * INTO v_session
    FROM terminal_sessions
    WHERE id = p_session_id AND device_id = p_device_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'invalid'::TEXT, NULL::BIGINT;
        RETURN;
    END IF;

    IF v_session.status IN ('pending', 'active') AND v_session.expires_at <= now() THEN
        UPDATE terminal_sessions SET status = 'expired', closed_at = now(),
                                    close_reason = 'Session lifetime exceeded'
        WHERE id = p_session_id
        RETURNING * INTO v_session;
    END IF;

    -- Output is accepted until the session is closed so trailing output is not lost.
    IF v_session.status IN ('closed', 'expired', 'revoked') THEN
        RETURN QUERY SELECT v_session.status::TEXT, v_session.last_output_sequence;
        RETURN;
    END IF;

    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
        RETURN QUERY SELECT v_session.status::TEXT, v_session.last_output_sequence;
        RETURN;
    END IF;

    IF jsonb_array_length(p_items) > 200 THEN
        RAISE EXCEPTION 'too_many_output_chunks';
    END IF;

    v_seq := v_session.last_output_sequence;
    v_org_id := v_session.organization_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        v_stream  := COALESCE(v_item ->> 'stream', 'stdout');
        v_content := LEFT(v_item ->> 'content', 8192);

        IF v_stream NOT IN ('stdout', 'stderr', 'system') THEN
            v_stream := 'system';
        END IF;

        IF v_content IS NULL OR char_length(v_content) = 0 THEN
            CONTINUE;
        END IF;

        v_seq := v_seq + 1;

        INSERT INTO terminal_output (session_id, sequence, stream, content)
        VALUES (p_session_id, v_seq, v_stream, v_content);
    END LOOP;

    UPDATE terminal_sessions SET
        last_output_sequence = v_seq,
        last_activity_at     = now()
    WHERE id = p_session_id
    RETURNING * INTO v_session;

    -- Bounded buffer: retain at most ~terminal_buffer_chars of output per session.
    SELECT COALESCE(terminal_buffer_chars, 2000000) INTO v_buffer
    FROM organization_settings WHERE organization_id = v_org_id;

    v_keep := GREATEST(200, COALESCE(v_buffer, 2000000) / 4096);

    IF v_seq > v_keep THEN
        DELETE FROM terminal_output
        WHERE session_id = p_session_id
          AND sequence <= v_seq - v_keep;
    END IF;

    RETURN QUERY SELECT v_session.status::TEXT, v_seq;
END;
$$;

-- ============================================================
-- AGENT COMMAND RESULT
-- ============================================================
CREATE OR REPLACE FUNCTION terminal_agent_command_result(
    p_session_id      UUID,
    p_device_id       UUID,
    p_command_sequence BIGINT,
    p_exit_ok         BOOLEAN,
    p_error           TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM terminal_sessions
        WHERE id = p_session_id AND device_id = p_device_id
    ) THEN
        RETURN FALSE;
    END IF;

    UPDATE terminal_commands SET
        completed_at  = now(),
        exit_ok       = p_exit_ok,
        error_summary = LEFT(p_error, 1000)
    WHERE session_id = p_session_id
      AND sequence = p_command_sequence;

    RETURN FOUND;
END;
$$;

-- ============================================================
-- POST COMMAND (dashboard server, administrator only)
-- ============================================================
CREATE OR REPLACE FUNCTION terminal_post_command(
    p_session_id UUID,
    p_actor      UUID,
    p_command    TEXT
)
RETURNS TABLE (result TEXT, command_sequence BIGINT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session terminal_sessions;
    v_seq     BIGINT;
BEGIN
    SELECT * INTO v_session FROM terminal_sessions
    WHERE id = p_session_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'not_found'::TEXT, NULL::BIGINT;
        RETURN;
    END IF;

    IF NOT terminal_actor_is_admin(v_session.organization_id, p_actor) THEN
        RETURN QUERY SELECT 'forbidden'::TEXT, NULL::BIGINT;
        RETURN;
    END IF;

    IF v_session.status NOT IN ('pending', 'active') THEN
        RETURN QUERY SELECT 'session_closed'::TEXT, NULL::BIGINT;
        RETURN;
    END IF;

    IF v_session.expires_at <= now() THEN
        UPDATE terminal_sessions SET status = 'expired', closed_at = now(),
                                    close_reason = 'Session lifetime exceeded'
        WHERE id = p_session_id;
        RETURN QUERY SELECT 'session_expired'::TEXT, NULL::BIGINT;
        RETURN;
    END IF;

    IF p_command IS NULL OR char_length(TRIM(p_command)) = 0
       OR char_length(p_command) > 16384 THEN
        RETURN QUERY SELECT 'invalid_command'::TEXT, NULL::BIGINT;
        RETURN;
    END IF;

    v_seq := v_session.last_command_sequence + 1;

    INSERT INTO terminal_commands (session_id, sequence, command, created_by)
    VALUES (p_session_id, v_seq, p_command, p_actor);

    UPDATE terminal_sessions SET
        last_command_sequence = v_seq,
        last_activity_at      = now()
    WHERE id = p_session_id;

    INSERT INTO audit_events (organization_id, actor_type, actor_id, action,
                              target_type, target_id, metadata)
    VALUES (v_session.organization_id, 'user', p_actor, 'terminal.command_sent',
            'terminal_session', p_session_id,
            jsonb_build_object(
                'sequence', v_seq,
                'command_sha256', encode(digest(p_command, 'sha256'), 'hex'),
                'command_preview', LEFT(p_command, 200)
            ));

    RETURN QUERY SELECT 'ok'::TEXT, v_seq;
END;
$$;

-- ============================================================
-- CLOSE SESSION (administrator or owning agent)
-- ============================================================
CREATE OR REPLACE FUNCTION terminal_close_session(
    p_session_id  UUID,
    p_actor       UUID DEFAULT NULL,
    p_reason      TEXT DEFAULT NULL,
    p_device_id   UUID DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session terminal_sessions;
    v_actor_type actor_type;
    v_actor_id UUID;
BEGIN
    SELECT * INTO v_session FROM terminal_sessions
    WHERE id = p_session_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN 'not_found';
    END IF;

    IF p_device_id IS NOT NULL THEN
        IF v_session.device_id <> p_device_id THEN
            RETURN 'forbidden';
        END IF;
        v_actor_type := 'device';
        v_actor_id := p_device_id;
    ELSE
        IF p_actor IS NULL OR NOT terminal_actor_is_admin(v_session.organization_id, p_actor) THEN
            RETURN 'forbidden';
        END IF;
        v_actor_type := 'user';
        v_actor_id := p_actor;
    END IF;

    IF v_session.status NOT IN ('pending', 'active') THEN
        RETURN 'already_closed';
    END IF;

    UPDATE terminal_sessions SET
        status       = 'closed',
        closed_at    = now(),
        close_reason = LEFT(COALESCE(NULLIF(p_reason, ''), 'Session closed'), 500)
    WHERE id = p_session_id;

    INSERT INTO audit_events (organization_id, actor_type, actor_id, action,
                              target_type, target_id, metadata)
    VALUES (v_session.organization_id, v_actor_type, v_actor_id, 'terminal.session_closed',
            'terminal_session', p_session_id,
            jsonb_build_object('reason', COALESCE(p_reason, 'Session closed')));

    RETURN 'ok';
END;
$$;

-- ============================================================
-- EXPIRE STALE SESSIONS (idle timeout / lifetime)
-- ============================================================
CREATE OR REPLACE FUNCTION terminal_expire_stale(p_idle_secs INT DEFAULT 900)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INT;
BEGIN
    WITH closed AS (
        UPDATE terminal_sessions SET
            status = 'expired',
            closed_at = now(),
            close_reason = CASE
                WHEN expires_at <= now() THEN 'Session lifetime exceeded'
                ELSE 'Session closed after inactivity timeout'
            END
        WHERE status IN ('pending', 'active')
          AND (
              expires_at <= now()
              OR last_activity_at < now() - make_interval(secs => GREATEST(p_idle_secs, 60))
          )
        RETURNING id
    )
    SELECT COUNT(*) INTO v_count FROM closed;

    RETURN v_count;
END;
$$;

-- ============================================================
-- DEVICE LIFECYCLE (authorize / suspend / resume / revoke)
-- Immediately terminates terminal sessions and cancels queued jobs.
-- ============================================================
CREATE OR REPLACE FUNCTION device_set_lifecycle_state(
    p_device_id UUID,
    p_org_id    UUID,
    p_actor     UUID,
    p_action    TEXT,
    p_reason    TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_device devices;
    v_status enrollment_status;
BEGIN
    SELECT * INTO v_device FROM devices
    WHERE id = p_device_id AND organization_id = p_org_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN 'not_found';
    END IF;

    IF p_actor IS NULL OR NOT terminal_actor_is_admin(p_org_id, p_actor) THEN
        RETURN 'forbidden';
    END IF;

    IF p_action = 'authorize' THEN
        IF v_device.enrollment_status NOT IN ('unauthorized', 'suspended', 'pending') THEN
            RETURN 'invalid_state';
        END IF;
        UPDATE devices SET
            enrollment_status = 'enrolled',
            authorized_at     = now(),
            authorized_by     = p_actor,
            suspended_at      = NULL,
            status_reason     = NULL
        WHERE id = p_device_id;

    ELSIF p_action = 'suspend' THEN
        IF v_device.enrollment_status <> 'enrolled' THEN
            RETURN 'invalid_state';
        END IF;
        UPDATE devices SET
            enrollment_status = 'suspended',
            suspended_at      = now(),
            status_reason     = LEFT(COALESCE(p_reason, 'Suspended by administrator'), 500)
        WHERE id = p_device_id;

    ELSIF p_action = 'resume' THEN
        IF v_device.enrollment_status <> 'suspended' THEN
            RETURN 'invalid_state';
        END IF;
        UPDATE devices SET
            enrollment_status = 'enrolled',
            suspended_at      = NULL,
            status_reason     = NULL
        WHERE id = p_device_id;

    ELSIF p_action = 'revoke' THEN
        IF v_device.enrollment_status = 'revoked' THEN
            RETURN 'invalid_state';
        END IF;
        UPDATE devices SET
            enrollment_status = 'revoked',
            revoked_at        = now(),
            status_reason     = LEFT(COALESCE(p_reason, 'Revoked by administrator'), 500),
            api_key_hash      = encode(digest(gen_random_uuid()::TEXT, 'sha256'), 'hex')
        WHERE id = p_device_id;

    ELSE
        RETURN 'invalid_action';
    END IF;

    SELECT enrollment_status INTO v_status FROM devices WHERE id = p_device_id;

    IF v_status IN ('suspended', 'revoked') THEN
        -- Stop live terminal activity immediately.
        UPDATE terminal_sessions SET
            status = CASE WHEN v_status = 'revoked' THEN 'revoked'::terminal_session_state
                          ELSE 'closed'::terminal_session_state END,
            closed_at = now(),
            close_reason = CASE WHEN v_status = 'revoked'
                                THEN 'Device access revoked'
                                ELSE 'Device suspended' END
        WHERE device_id = p_device_id
          AND status IN ('pending', 'active');

        UPDATE jobs SET
            state = 'cancelled',
            completed_at = now(),
            error_summary = CASE WHEN v_status = 'revoked'
                                 THEN 'Device access revoked'
                                 ELSE 'Device suspended' END,
            updated_at = now()
        WHERE device_id = p_device_id
          AND state IN ('queued', 'waiting_for_device', 'claimed');
    END IF;

    INSERT INTO audit_events (organization_id, actor_type, actor_id, action,
                              target_type, target_id, metadata)
    VALUES (p_org_id, 'user', p_actor,
            CASE p_action
                WHEN 'authorize' THEN 'device.authorized'
                WHEN 'suspend'   THEN 'device.suspended'
                WHEN 'resume'    THEN 'device.resumed'
                WHEN 'revoke'    THEN 'device.revoked'
            END,
            'device', p_device_id,
            jsonb_build_object('previous_status', v_device.enrollment_status::TEXT,
                               'new_status', v_status::TEXT,
                               'reason', p_reason));

    RETURN 'ok';
END;
$$;

-- ============================================================
-- PRIVILEGES: all writes are RPC-only, executable by the service role.
-- ============================================================
REVOKE ALL ON FUNCTION terminal_actor_is_admin(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION terminal_create_session(UUID, UUID, INET) FROM PUBLIC;
REVOKE ALL ON FUNCTION terminal_agent_claim(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION terminal_agent_poll(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION terminal_agent_append_output(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION terminal_agent_command_result(UUID, UUID, BIGINT, BOOLEAN, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION terminal_post_command(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION terminal_close_session(UUID, UUID, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION terminal_expire_stale(INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION device_set_lifecycle_state(UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION terminal_actor_is_admin(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION terminal_create_session(UUID, UUID, INET) TO service_role;
GRANT EXECUTE ON FUNCTION terminal_agent_claim(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION terminal_agent_poll(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION terminal_agent_append_output(UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION terminal_agent_command_result(UUID, UUID, BIGINT, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION terminal_post_command(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION terminal_close_session(UUID, UUID, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION terminal_expire_stale(INT) TO service_role;
GRANT EXECUTE ON FUNCTION device_set_lifecycle_state(UUID, UUID, UUID, TEXT, TEXT) TO service_role;
