-- ============================================================
-- File: 001_initial_schema.sql
-- ============================================================
-- Migration: 001_initial_schema.sql
-- Description: Core schema for ScriptRunner platform
-- Phase: 1 â€“ Organizations, members, devices, invitations

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ORGANIZATIONS
-- ============================================================
CREATE TABLE organizations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    slug         TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9\-]{2,60}$'),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_organizations_slug ON organizations (slug);

-- ============================================================
-- ORGANIZATION MEMBERS
-- ============================================================
CREATE TYPE member_role AS ENUM ('owner', 'administrator', 'operator', 'auditor');

CREATE TABLE organization_members (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    role            member_role NOT NULL DEFAULT 'auditor',
    invited_by      UUID REFERENCES auth.users (id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, user_id)
);

CREATE INDEX idx_org_members_user    ON organization_members (user_id);
CREATE INDEX idx_org_members_org     ON organization_members (organization_id);
CREATE INDEX idx_org_members_org_role ON organization_members (organization_id, role);

-- ============================================================
-- DEVICES
-- ============================================================
CREATE TYPE enrollment_status AS ENUM ('pending', 'enrolled', 'revoked');

CREATE TABLE devices (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    display_name      TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
    hostname          TEXT CHECK (char_length(hostname) <= 253),
    operating_system  TEXT CHECK (char_length(operating_system) <= 100),
    agent_version     TEXT CHECK (char_length(agent_version) <= 40),
    enrollment_status enrollment_status NOT NULL DEFAULT 'pending',
    last_seen_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at        TIMESTAMPTZ,
    -- Non-sensitive operational metadata only (no credentials)
    metadata          JSONB NOT NULL DEFAULT '{}' CHECK (pg_column_size(metadata) <= 4096),
    -- The hashed API key used by the device agent (NEVER store plaintext)
    api_key_hash      TEXT NOT NULL,
    -- Salt used when hashing the API key
    api_key_prefix    TEXT NOT NULL CHECK (char_length(api_key_prefix) = 8),
    enrolled_by       UUID REFERENCES auth.users (id),
    enrolled_at       TIMESTAMPTZ,
    CONSTRAINT chk_revoked_status CHECK (
        (revoked_at IS NULL AND enrollment_status != 'revoked')
        OR (revoked_at IS NOT NULL AND enrollment_status = 'revoked')
    )
);

CREATE INDEX idx_devices_org         ON devices (organization_id);
CREATE INDEX idx_devices_org_status  ON devices (organization_id, enrollment_status);
CREATE INDEX idx_devices_last_seen   ON devices (last_seen_at);
CREATE INDEX idx_devices_api_prefix  ON devices (api_key_prefix);

-- ============================================================
-- ENROLLMENT INVITATIONS
-- ============================================================
CREATE TABLE enrollment_invitations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    created_by      UUID NOT NULL REFERENCES auth.users (id),
    -- SHA-256 hex digest of the one-time token. Token itself is never stored.
    token_hash      TEXT NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
    -- First 8 chars of the token (hex) for display/lookup without exposing the secret
    token_prefix    TEXT NOT NULL CHECK (char_length(token_prefix) = 8),
    display_name    TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
    expires_at      TIMESTAMPTZ NOT NULL,
    redeemed_at     TIMESTAMPTZ,
    redeemed_by_device UUID REFERENCES devices (id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_expiry_future CHECK (expires_at > created_at),
    CONSTRAINT chk_redeemed_once CHECK (
        (redeemed_at IS NULL AND redeemed_by_device IS NULL)
        OR (redeemed_at IS NOT NULL AND redeemed_by_device IS NOT NULL)
    )
);

CREATE INDEX idx_invitations_org      ON enrollment_invitations (organization_id);
CREATE INDEX idx_invitations_token    ON enrollment_invitations (token_hash);
CREATE INDEX idx_invitations_expires  ON enrollment_invitations (expires_at) WHERE redeemed_at IS NULL;

-- ============================================================
-- UPDATED_AT trigger helper
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_organizations_updated_at
    BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_org_members_updated_at
    BEFORE UPDATE ON organization_members
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_devices_updated_at
    BEFORE UPDATE ON devices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();



-- ============================================================
-- File: 002_jobs_schema.sql
-- ============================================================
-- Migration: 002_jobs_schema.sql
-- Description: Jobs, attempts, audit events and supporting types

-- ============================================================
-- JOB STATES
-- ============================================================
CREATE TYPE job_state AS ENUM (
    'queued',
    'waiting_for_device',
    'claimed',
    'running',
    'succeeded',
    'failed',
    'timed_out',
    'cancelled',
    'expired',
    'outcome_unknown'
);

CREATE TYPE script_type AS ENUM ('powershell');

-- ============================================================
-- JOBS
-- ============================================================
CREATE TABLE jobs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    device_id         UUID NOT NULL REFERENCES devices (id),
    created_by        UUID NOT NULL REFERENCES auth.users (id),
    -- Script content: limited size, protected by RLS
    script_content    TEXT NOT NULL CHECK (
        char_length(script_content) BETWEEN 1 AND 131072  -- 128 KB hard limit
    ),
    script_type       script_type NOT NULL DEFAULT 'powershell',
    -- SHA-256 hex of script_content at submission time
    script_hash       TEXT NOT NULL CHECK (char_length(script_hash) = 64),
    description       TEXT CHECK (char_length(description) <= 500),
    change_ticket     TEXT CHECK (char_length(change_ticket) <= 100),
    state             job_state NOT NULL DEFAULT 'queued',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Earliest time the job may be executed (NULL = immediately)
    not_before        TIMESTAMPTZ,
    -- Absolute deadline: job must START before this time or it expires
    expires_at        TIMESTAMPTZ NOT NULL,
    -- When the agent atomically claimed this job
    claimed_at        TIMESTAMPTZ,
    claimed_by_device UUID REFERENCES devices (id),
    -- When the script process actually started
    started_at        TIMESTAMPTZ,
    -- When the job reached a terminal state
    completed_at      TIMESTAMPTZ,
    -- Max seconds the script process may run (1 â€“ 86400)
    timeout_seconds   INT NOT NULL DEFAULT 300 CHECK (timeout_seconds BETWEEN 1 AND 86400),
    -- Client-supplied dedup key (max 128 chars)
    idempotency_key   TEXT CHECK (char_length(idempotency_key) <= 128),
    -- Brief human-readable error for failure/timeout/unknown
    error_summary     TEXT CHECK (char_length(error_summary) <= 1000),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_expires_after_created CHECK (expires_at > created_at),
    CONSTRAINT chk_not_before_before_expires CHECK (
        not_before IS NULL OR not_before < expires_at
    ),
    CONSTRAINT chk_device_org_match CHECK (
        -- enforced by trigger below; placeholder constraint
        TRUE
    )
);

-- Unique idempotency key per organization (NULL values are always unique in PG)
CREATE UNIQUE INDEX idx_jobs_idempotency
    ON jobs (organization_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_jobs_org           ON jobs (organization_id);
CREATE INDEX idx_jobs_device        ON jobs (device_id);
CREATE INDEX idx_jobs_state         ON jobs (state);
CREATE INDEX idx_jobs_expires       ON jobs (expires_at);
-- Composite for agent polling query: eligible pending jobs for a device
CREATE INDEX idx_jobs_agent_poll
    ON jobs (device_id, state, expires_at)
    WHERE state IN ('queued', 'waiting_for_device');
-- For dashboard history queries
CREATE INDEX idx_jobs_org_created   ON jobs (organization_id, created_at DESC);
CREATE INDEX idx_jobs_org_state     ON jobs (organization_id, state, created_at DESC);

CREATE TRIGGER trg_jobs_updated_at
    BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Enforce device belongs to same organization as job
CREATE OR REPLACE FUNCTION check_device_org_match()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM devices
        WHERE id = NEW.device_id
          AND organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'device % does not belong to organization %',
            NEW.device_id, NEW.organization_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_jobs_device_org
    BEFORE INSERT ON jobs
    FOR EACH ROW EXECUTE FUNCTION check_device_org_match();

-- ============================================================
-- JOB ATTEMPTS
-- ============================================================
CREATE TYPE attempt_outcome AS ENUM (
    'succeeded', 'failed', 'timed_out', 'cancelled', 'outcome_unknown'
);

CREATE TABLE job_attempts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id              UUID NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    device_id           UUID NOT NULL REFERENCES devices (id),
    attempt_number      INT NOT NULL CHECK (attempt_number >= 1),
    state               job_state NOT NULL,
    -- Unique identifier generated by the agent for this execution
    agent_execution_id  TEXT CHECK (char_length(agent_execution_id) <= 64),
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    exit_code           INT,
    -- Bounded stdout (first 65536 chars captured; rest discarded)
    stdout_text         TEXT CHECK (char_length(stdout_text) <= 65536),
    stdout_truncated    BOOLEAN NOT NULL DEFAULT FALSE,
    -- Bounded stderr (first 16384 chars captured)
    stderr_text         TEXT CHECK (char_length(stderr_text) <= 16384),
    stderr_truncated    BOOLEAN NOT NULL DEFAULT FALSE,
    outcome             attempt_outcome,
    error_summary       TEXT CHECK (char_length(error_summary) <= 1000),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (job_id, attempt_number)
);

CREATE INDEX idx_attempts_job     ON job_attempts (job_id);
CREATE INDEX idx_attempts_device  ON job_attempts (device_id);
CREATE INDEX idx_attempts_state   ON job_attempts (state);

CREATE TRIGGER trg_attempts_updated_at
    BEFORE UPDATE ON job_attempts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- AUDIT EVENTS (append-only)
-- ============================================================
CREATE TYPE actor_type AS ENUM ('user', 'device', 'system');

CREATE TABLE audit_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations (id),
    actor_type      actor_type NOT NULL,
    -- UUID of the user or device that performed the action
    actor_id        UUID,
    action          TEXT NOT NULL CHECK (char_length(action) <= 120),
    target_type     TEXT CHECK (char_length(target_type) <= 60),
    target_id       UUID,
    -- Structured metadata excluding credentials and unnecessary sensitive data
    metadata        JSONB NOT NULL DEFAULT '{}' CHECK (pg_column_size(metadata) <= 8192),
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- IP address of the actor at time of action (nullable for device/system events)
    ip_address      INET
);

-- Audit events are INSERT-only; no UPDATE or DELETE allowed via application roles
CREATE INDEX idx_audit_org       ON audit_events (organization_id, timestamp DESC);
CREATE INDEX idx_audit_actor     ON audit_events (actor_id, timestamp DESC);
CREATE INDEX idx_audit_target    ON audit_events (target_type, target_id, timestamp DESC);
CREATE INDEX idx_audit_action    ON audit_events (action, timestamp DESC);

-- ============================================================
-- ORGANIZATION SETTINGS (for execution policy, limits)
-- ============================================================
CREATE TABLE organization_settings (
    organization_id        UUID PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
    -- max script size in bytes (1 KB â€“ 128 KB)
    max_script_bytes       INT NOT NULL DEFAULT 131072 CHECK (max_script_bytes BETWEEN 1024 AND 131072),
    -- default job timeout
    default_timeout_secs   INT NOT NULL DEFAULT 300 CHECK (default_timeout_secs BETWEEN 10 AND 86400),
    -- max job lifetime before expiry
    default_expiry_secs    INT NOT NULL DEFAULT 86400 CHECK (default_expiry_secs BETWEEN 60 AND 604800),
    -- max stdout retained per attempt (bytes)
    max_stdout_bytes       INT NOT NULL DEFAULT 65536 CHECK (max_stdout_bytes BETWEEN 1024 AND 65536),
    -- whether operators (non-admin) can submit jobs
    operators_can_submit   BOOLEAN NOT NULL DEFAULT FALSE,
    -- audit log retention days
    audit_retention_days   INT NOT NULL DEFAULT 90 CHECK (audit_retention_days BETWEEN 7 AND 3650),
    -- job output retention days
    output_retention_days  INT NOT NULL DEFAULT 30 CHECK (output_retention_days BETWEEN 1 AND 365),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_org_settings_updated_at
    BEFORE UPDATE ON organization_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();



-- ============================================================
-- File: 003_rls_policies.sql
-- ============================================================
-- Migration: 003_rls_policies.sql
-- Description: Row Level Security policies for all exposed tables
-- All tables have RLS enabled; service-role key bypasses RLS for Edge Functions.

-- ============================================================
-- Helper: get current user's role in a given organization
-- ============================================================
CREATE OR REPLACE FUNCTION auth_org_role(org_id UUID)
RETURNS member_role
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role member_role;
BEGIN
    SELECT role INTO v_role
    FROM organization_members
    WHERE organization_id = org_id
      AND user_id = auth.uid()
    LIMIT 1;
    RETURN v_role;
END;
$$;

-- Helper: check if current user has at least a minimum role
CREATE OR REPLACE FUNCTION auth_has_role(org_id UUID, min_role member_role)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role member_role;
    v_role_level INT;
    v_min_level INT;
BEGIN
    SELECT role INTO v_role
    FROM organization_members
    WHERE organization_id = org_id
      AND user_id = auth.uid()
    LIMIT 1;

    IF v_role IS NULL THEN
        RETURN FALSE;
    END IF;

    v_role_level := CASE v_role
        WHEN 'owner'         THEN 4
        WHEN 'administrator' THEN 3
        WHEN 'operator'      THEN 2
        WHEN 'auditor'       THEN 1
        ELSE 0
    END;

    v_min_level := CASE min_role
        WHEN 'owner'         THEN 4
        WHEN 'administrator' THEN 3
        WHEN 'operator'      THEN 2
        WHEN 'auditor'       THEN 1
        ELSE 0
    END;

    RETURN v_role_level >= v_min_level;
END;
$$;

-- Helper: get current device ID from JWT custom claim (set by Edge Function on device auth)
CREATE OR REPLACE FUNCTION auth_device_id()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
    SELECT NULLIF(
        (auth.jwt() ->> 'device_id')::TEXT,
        ''
    )::UUID;
$$;

-- Helper: check if current JWT is a device JWT (not a user session)
CREATE OR REPLACE FUNCTION auth_is_device()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
    SELECT (auth.jwt() ->> 'role') = 'device_agent';
$$;

-- ============================================================
-- ENABLE RLS ON ALL TABLES
-- ============================================================
ALTER TABLE organizations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members    ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollment_invitations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_attempts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_settings   ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- ORGANIZATIONS
-- ============================================================
-- Users can see only organizations they are members of
CREATE POLICY orgs_select ON organizations
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM organization_members
            WHERE organization_id = id
              AND user_id = auth.uid()
        )
    );

-- Only service role can insert organizations (via Edge Function / onboarding)
-- Users cannot directly create organizations via the API

-- ============================================================
-- ORGANIZATION MEMBERS
-- ============================================================
-- Members can see all members of their shared organizations
CREATE POLICY members_select ON organization_members
    FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR auth_has_role(organization_id, 'auditor')
    );

-- Only owners/administrators can insert members
CREATE POLICY members_insert ON organization_members
    FOR INSERT TO authenticated
    WITH CHECK (auth_has_role(organization_id, 'administrator'));

-- Only owners can update roles; administrators can invite auditors/operators
CREATE POLICY members_update ON organization_members
    FOR UPDATE TO authenticated
    USING (auth_has_role(organization_id, 'administrator'))
    WITH CHECK (auth_has_role(organization_id, 'administrator'));

-- Only owners can delete members
CREATE POLICY members_delete ON organization_members
    FOR DELETE TO authenticated
    USING (auth_has_role(organization_id, 'owner'));

-- ============================================================
-- DEVICES
-- ============================================================
-- Human users: can see devices in their organizations
CREATE POLICY devices_select_user ON devices
    FOR SELECT TO authenticated
    USING (
        NOT auth_is_device()
        AND EXISTS (
            SELECT 1 FROM organization_members
            WHERE organization_id = devices.organization_id
              AND user_id = auth.uid()
        )
    );

-- Device agents: can only see their own device record
CREATE POLICY devices_select_device ON devices
    FOR SELECT TO authenticated
    USING (
        auth_is_device()
        AND id = auth_device_id()
    );

-- Only administrators can enroll/update devices (via Edge Functions)
CREATE POLICY devices_insert ON devices
    FOR INSERT TO authenticated
    WITH CHECK (
        NOT auth_is_device()
        AND auth_has_role(organization_id, 'administrator')
    );

-- Administrators can update device metadata; devices can update last_seen/agent_version
-- Fine-grained column control is enforced in Edge Functions
CREATE POLICY devices_update_admin ON devices
    FOR UPDATE TO authenticated
    USING (
        NOT auth_is_device()
        AND auth_has_role(organization_id, 'administrator')
    );

CREATE POLICY devices_update_self ON devices
    FOR UPDATE TO authenticated
    USING (
        auth_is_device()
        AND id = auth_device_id()
        AND enrollment_status = 'enrolled'
    )
    WITH CHECK (
        auth_is_device()
        AND id = auth_device_id()
        -- Device cannot change these sensitive fields
        -- Column-level enforcement in the Edge Function/RPC
    );

-- ============================================================
-- ENROLLMENT INVITATIONS
-- ============================================================
-- Administrators and owners can see invitations for their org
CREATE POLICY invitations_select ON enrollment_invitations
    FOR SELECT TO authenticated
    USING (
        NOT auth_is_device()
        AND auth_has_role(organization_id, 'administrator')
    );

-- Only administrators can create invitations
CREATE POLICY invitations_insert ON enrollment_invitations
    FOR INSERT TO authenticated
    WITH CHECK (
        NOT auth_is_device()
        AND auth_has_role(organization_id, 'administrator')
    );

-- Redemption is done via Edge Function with service role; no direct UPDATE allowed

-- ============================================================
-- JOBS
-- ============================================================
-- Users: see jobs in their organizations; script content only for admin+
CREATE POLICY jobs_select_user ON jobs
    FOR SELECT TO authenticated
    USING (
        NOT auth_is_device()
        AND EXISTS (
            SELECT 1 FROM organization_members
            WHERE organization_id = jobs.organization_id
              AND user_id = auth.uid()
        )
    );

-- Device agents: see only their own eligible, non-expired, non-revoked jobs
CREATE POLICY jobs_select_device ON jobs
    FOR SELECT TO authenticated
    USING (
        auth_is_device()
        AND device_id = auth_device_id()
        AND state IN ('queued', 'waiting_for_device', 'claimed', 'running')
        AND expires_at > now()
        AND NOT EXISTS (
            SELECT 1 FROM devices d
            WHERE d.id = auth_device_id()
              AND d.enrollment_status = 'revoked'
        )
    );

-- Job submission via Edge Function (service role); direct INSERT not allowed here
-- but we add a policy for the case where the Edge Function uses the anon/user key
CREATE POLICY jobs_insert ON jobs
    FOR INSERT TO authenticated
    WITH CHECK (
        NOT auth_is_device()
        AND auth_has_role(organization_id, 'operator')
    );

-- State updates: admin can cancel; device can update its own job's state
CREATE POLICY jobs_update_admin ON jobs
    FOR UPDATE TO authenticated
    USING (
        NOT auth_is_device()
        AND auth_has_role(organization_id, 'administrator')
    );

CREATE POLICY jobs_update_device ON jobs
    FOR UPDATE TO authenticated
    USING (
        auth_is_device()
        AND device_id = auth_device_id()
        AND NOT EXISTS (
            SELECT 1 FROM devices d
            WHERE d.id = auth_device_id()
              AND d.enrollment_status = 'revoked'
        )
    );

-- ============================================================
-- JOB ATTEMPTS
-- ============================================================
-- Users: read attempts for jobs in their org
CREATE POLICY attempts_select_user ON job_attempts
    FOR SELECT TO authenticated
    USING (
        NOT auth_is_device()
        AND EXISTS (
            SELECT 1 FROM jobs j
            JOIN organization_members m ON m.organization_id = j.organization_id
            WHERE j.id = job_id
              AND m.user_id = auth.uid()
        )
    );

-- Device: read and write only its own attempts
CREATE POLICY attempts_select_device ON job_attempts
    FOR SELECT TO authenticated
    USING (
        auth_is_device()
        AND device_id = auth_device_id()
    );

CREATE POLICY attempts_insert_device ON job_attempts
    FOR INSERT TO authenticated
    WITH CHECK (
        auth_is_device()
        AND device_id = auth_device_id()
    );

CREATE POLICY attempts_update_device ON job_attempts
    FOR UPDATE TO authenticated
    USING (
        auth_is_device()
        AND device_id = auth_device_id()
    );

-- ============================================================
-- AUDIT EVENTS (append-only; no UPDATE or DELETE)
-- ============================================================
-- Users read audit events for their org
CREATE POLICY audit_select ON audit_events
    FOR SELECT TO authenticated
    USING (
        NOT auth_is_device()
        AND auth_has_role(organization_id, 'auditor')
    );

-- Any authenticated principal can insert audit events
CREATE POLICY audit_insert ON audit_events
    FOR INSERT TO authenticated
    WITH CHECK (TRUE);

-- No UPDATE or DELETE policies â†’ those operations are denied to all app roles

-- ============================================================
-- ORGANIZATION SETTINGS
-- ============================================================
CREATE POLICY settings_select ON organization_settings
    FOR SELECT TO authenticated
    USING (
        NOT auth_is_device()
        AND auth_has_role(organization_id, 'auditor')
    );

CREATE POLICY settings_update ON organization_settings
    FOR UPDATE TO authenticated
    USING (
        NOT auth_is_device()
        AND auth_has_role(organization_id, 'owner')
    );



-- ============================================================
-- File: 004_atomic_rpcs.sql
-- ============================================================
-- Migration: 004_atomic_rpcs.sql
-- Description: Atomic RPCs for job claiming, state transitions, and enrollment

-- ============================================================
-- CLAIM JOB (atomic, prevents double-claim)
-- Called by device agent via Edge Function.
-- Returns the claimed job row or NULL if nothing to claim.
-- ============================================================
CREATE OR REPLACE FUNCTION claim_next_job(p_device_id UUID)
RETURNS SETOF jobs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_job jobs;
BEGIN
    -- Verify device is enrolled and not revoked
    IF NOT EXISTS (
        SELECT 1 FROM devices
        WHERE id = p_device_id
          AND enrollment_status = 'enrolled'
    ) THEN
        RETURN;
    END IF;

    -- Lock and claim one eligible job atomically
    SELECT * INTO v_job
    FROM jobs
    WHERE device_id = p_device_id
      AND state IN ('queued', 'waiting_for_device')
      AND expires_at > now()
      AND (not_before IS NULL OR not_before <= now())
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF v_job IS NULL THEN
        RETURN;
    END IF;

    -- Transition to claimed
    UPDATE jobs SET
        state         = 'claimed',
        claimed_at    = now(),
        claimed_by_device = p_device_id,
        updated_at    = now()
    WHERE id = v_job.id
      AND state IN ('queued', 'waiting_for_device'); -- guard against race

    -- Return the updated job
    RETURN QUERY
        SELECT * FROM jobs WHERE id = v_job.id;
END;
$$;

-- ============================================================
-- MARK JOB RUNNING
-- ============================================================
CREATE OR REPLACE FUNCTION mark_job_running(
    p_job_id     UUID,
    p_device_id  UUID,
    p_attempt_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE jobs SET
        state      = 'running',
        started_at = now(),
        updated_at = now()
    WHERE id = p_job_id
      AND device_id = p_device_id
      AND state = 'claimed';

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    UPDATE job_attempts SET
        state      = 'running',
        started_at = now(),
        updated_at = now()
    WHERE id = p_attempt_id
      AND job_id = p_job_id
      AND device_id = p_device_id;

    RETURN TRUE;
END;
$$;

-- ============================================================
-- COMPLETE JOB (terminal state transition)
-- ============================================================
CREATE OR REPLACE FUNCTION complete_job(
    p_job_id          UUID,
    p_device_id       UUID,
    p_attempt_id      UUID,
    p_outcome         attempt_outcome,
    p_exit_code       INT,
    p_stdout_text     TEXT,
    p_stdout_truncated BOOLEAN,
    p_stderr_text     TEXT,
    p_stderr_truncated BOOLEAN,
    p_error_summary   TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_job_state job_state;
BEGIN
    -- Map attempt outcome to job state
    v_job_state := CASE p_outcome
        WHEN 'succeeded'      THEN 'succeeded'::job_state
        WHEN 'failed'         THEN 'failed'::job_state
        WHEN 'timed_out'      THEN 'timed_out'::job_state
        WHEN 'cancelled'      THEN 'cancelled'::job_state
        WHEN 'outcome_unknown' THEN 'outcome_unknown'::job_state
    END;

    UPDATE jobs SET
        state        = v_job_state,
        completed_at = now(),
        error_summary = p_error_summary,
        updated_at   = now()
    WHERE id = p_job_id
      AND device_id = p_device_id
      AND state IN ('running', 'claimed');

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    UPDATE job_attempts SET
        state             = v_job_state,
        completed_at      = now(),
        exit_code         = p_exit_code,
        stdout_text       = LEFT(p_stdout_text, 65536),
        stdout_truncated  = p_stdout_truncated,
        stderr_text       = LEFT(p_stderr_text, 16384),
        stderr_truncated  = p_stderr_truncated,
        outcome           = p_outcome,
        error_summary     = p_error_summary,
        updated_at        = now()
    WHERE id = p_attempt_id
      AND job_id = p_job_id;

    RETURN TRUE;
END;
$$;

-- ============================================================
-- CANCEL QUEUED JOB (admin action)
-- ============================================================
CREATE OR REPLACE FUNCTION cancel_job(
    p_job_id         UUID,
    p_actor_user_id  UUID,
    p_org_id         UUID
)
RETURNS TEXT  -- returns 'ok', 'not_found', 'already_terminal', 'best_effort_running'
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_current_state job_state;
BEGIN
    SELECT state INTO v_current_state
    FROM jobs
    WHERE id = p_job_id
      AND organization_id = p_org_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN 'not_found';
    END IF;

    IF v_current_state IN ('succeeded', 'failed', 'timed_out', 'cancelled', 'expired', 'outcome_unknown') THEN
        RETURN 'already_terminal';
    END IF;

    IF v_current_state = 'running' THEN
        -- Best-effort: set state but execution may have already completed
        UPDATE jobs SET
            state        = 'cancelled',
            completed_at = now(),
            error_summary = 'Cancelled by administrator while running (best-effort)',
            updated_at   = now()
        WHERE id = p_job_id;
        RETURN 'best_effort_running';
    END IF;

    -- queued / waiting_for_device / claimed
    UPDATE jobs SET
        state        = 'cancelled',
        completed_at = now(),
        error_summary = 'Cancelled by administrator',
        updated_at   = now()
    WHERE id = p_job_id;

    RETURN 'ok';
END;
$$;

-- ============================================================
-- EXPIRE STALE JOBS (run by cron or Edge Function)
-- ============================================================
CREATE OR REPLACE FUNCTION expire_stale_jobs()
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INT;
BEGIN
    WITH expired AS (
        UPDATE jobs SET
            state        = 'expired',
            completed_at = now(),
            error_summary = 'Job expired before execution began',
            updated_at   = now()
        WHERE state IN ('queued', 'waiting_for_device')
          AND expires_at <= now()
        RETURNING id
    )
    SELECT COUNT(*) INTO v_count FROM expired;

    RETURN v_count;
END;
$$;

-- ============================================================
-- DEVICE HEARTBEAT UPDATE (atomic, device-only)
-- ============================================================
CREATE OR REPLACE FUNCTION device_heartbeat(p_device_id UUID, p_agent_version TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE devices SET
        last_seen_at  = now(),
        agent_version = LEFT(p_agent_version, 40),
        updated_at    = now()
    WHERE id = p_device_id
      AND enrollment_status = 'enrolled';

    RETURN FOUND;
END;
$$;

-- ============================================================
-- RECONCILE AMBIGUOUS JOBS (on agent restart)
-- Returns jobs in 'claimed' or 'running' state for the device
-- that have no corresponding completed attempt â€” agent must resolve
-- ============================================================
CREATE OR REPLACE FUNCTION get_ambiguous_jobs(p_device_id UUID)
RETURNS TABLE (
    job_id      UUID,
    attempt_id  UUID,
    state       job_state,
    claimed_at  TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
    SELECT j.id, ja.id, j.state, j.claimed_at
    FROM jobs j
    LEFT JOIN job_attempts ja ON ja.job_id = j.id AND ja.device_id = p_device_id
    WHERE j.device_id = p_device_id
      AND j.state IN ('claimed', 'running')
      AND (ja.id IS NULL OR ja.outcome IS NULL)
    ORDER BY j.claimed_at ASC;
$$;

-- ============================================================
-- REDEEM ENROLLMENT INVITATION (atomic)
-- Returns 'ok', 'not_found', 'expired', 'already_redeemed', or 'device_error'
-- ============================================================
CREATE OR REPLACE FUNCTION redeem_enrollment_invitation(
    p_token_hash   TEXT,
    p_org_id       UUID,
    p_device_id    UUID,
    p_hostname     TEXT,
    p_os           TEXT,
    p_agent_version TEXT,
    p_display_name TEXT
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_inv enrollment_invitations;
BEGIN
    SELECT * INTO v_inv
    FROM enrollment_invitations
    WHERE token_hash = p_token_hash
      AND organization_id = p_org_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN 'not_found';
    END IF;

    IF v_inv.expires_at < now() THEN
        RETURN 'expired';
    END IF;

    IF v_inv.redeemed_at IS NOT NULL THEN
        RETURN 'already_redeemed';
    END IF;

    -- Mark invitation redeemed
    UPDATE enrollment_invitations SET
        redeemed_at       = now(),
        redeemed_by_device = p_device_id
    WHERE id = v_inv.id;

    -- Activate the device
    UPDATE devices SET
        enrollment_status = 'enrolled',
        hostname          = LEFT(p_hostname, 253),
        operating_system  = LEFT(p_os, 100),
        agent_version     = LEFT(p_agent_version, 40),
        display_name      = LEFT(p_display_name, 120),
        enrolled_at       = now(),
        last_seen_at      = now(),
        updated_at        = now()
    WHERE id = p_device_id
      AND organization_id = p_org_id
      AND enrollment_status = 'pending';

    IF NOT FOUND THEN
        RETURN 'device_error';
    END IF;

    RETURN 'ok';
END;
$$;



-- ============================================================
-- File: 005_seed_dev.sql
-- ============================================================
-- Migration: 005_seed_dev.sql
-- Description: Development seed data (local Supabase only â€“ never run in production)
-- Seeds one organization and one owner user for local testing.

-- WARNING: This seed contains no real credentials.
-- The test user will sign up via Supabase Auth in the local dev flow.

INSERT INTO organizations (id, name, slug)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'Acme Corp (Dev)',
    'acme-dev'
) ON CONFLICT DO NOTHING;

INSERT INTO organization_settings (organization_id)
VALUES ('00000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;



-- ============================================================
-- File: 006_device_lifecycle.sql
-- ============================================================
-- Migration: 006_device_lifecycle.sql
-- Description: Device lifecycle states and telemetry needed for automatic enrollment.
--
-- NOTE: PostgreSQL does not allow a newly added enum value to be *used* in the same
-- transaction in which it is added. This migration therefore only changes types and
-- columns; migrations that reference the new values live in later files.

-- ============================================================
-- ENROLLMENT STATES
--   pending      â€“ legacy invitation placeholder, never enrolled
--   unauthorized â€“ self-enrolled through the organization enrollment key,
--                  awaiting administrator authorization
--   enrolled     â€“ authorized; may receive commands and terminal sessions
--   suspended    â€“ temporarily blocked by an administrator
--   revoked      â€“ permanently blocked
-- ============================================================
ALTER TYPE enrollment_status ADD VALUE IF NOT EXISTS 'unauthorized';
ALTER TYPE enrollment_status ADD VALUE IF NOT EXISTS 'suspended';

-- ============================================================
-- DEVICE COLUMNS (auto-enrollment + telemetry)
-- ============================================================
ALTER TABLE devices
    -- Stable identifier generated by the installer/agent instance, used to make
    -- enrollment retries idempotent. Never a secret.
    ADD COLUMN install_id          UUID,
    -- Last reported Windows service state ("running") and execution context.
    ADD COLUMN service_status      TEXT CHECK (char_length(service_status) <= 40),
    ADD COLUMN is_elevated         BOOLEAN,
    ADD COLUMN execution_account   TEXT CHECK (char_length(execution_account) <= 120),
    ADD COLUMN authorized_at       TIMESTAMPTZ,
    ADD COLUMN authorized_by       UUID REFERENCES auth.users (id),
    ADD COLUMN suspended_at        TIMESTAMPTZ,
    -- Human readable reason for the current non-active state.
    ADD COLUMN status_reason       TEXT CHECK (char_length(status_reason) <= 500),
    -- Time of the most recent successful command/session interaction (terminal)
    ADD COLUMN last_session_at     TIMESTAMPTZ;

CREATE UNIQUE INDEX uq_devices_org_install
    ON devices (organization_id, install_id)
    WHERE install_id IS NOT NULL;

-- ============================================================
-- ORGANIZATION ENROLLMENT POLICY SETTINGS
-- ============================================================
ALTER TABLE organization_settings
    -- When true a device that enrolls with a valid organization key is
    -- immediately 'enrolled'. When false it lands in 'unauthorized' and an
    -- administrator must authorize it before it can receive commands.
    ADD COLUMN auto_authorize_devices     BOOLEAN NOT NULL DEFAULT FALSE,
    -- Idle time before an unattended remote terminal session is closed.
    ADD COLUMN terminal_inactivity_secs   INT NOT NULL DEFAULT 900
        CHECK (terminal_inactivity_secs BETWEEN 60 AND 86400),
    -- Hard upper bound on a single terminal session lifetime.
    ADD COLUMN terminal_max_secs          INT NOT NULL DEFAULT 3600
        CHECK (terminal_max_secs BETWEEN 60 AND 86400),
    -- Maximum characters of terminal output retained per session (ring buffer).
    ADD COLUMN terminal_buffer_chars      INT NOT NULL DEFAULT 2000000
        CHECK (terminal_buffer_chars BETWEEN 10000 AND 10000000);



-- ============================================================
-- File: 007_enrollment_policy.sql
-- ============================================================
-- Migration: 007_enrollment_policy.sql
-- Description: Organization-level enrollment keys and automatic device enrollment.
--
-- Enrollment model
-- ----------------
-- A single, rotatable, organization-scoped enrollment key is delivered to the
-- installer (via MDM, image, or the admin running the MSI/PowerShell installer).
-- Each installation generates its own device ID and install ID locally; no
-- per-device invitation token and no typed device ID is required.
--
-- Only the SHA-256 hash of the key is stored. The plaintext key is shown once
-- when generated and can never be retrieved again.

-- ============================================================
-- ORGANIZATION ENROLLMENT KEYS
-- ============================================================
CREATE TABLE organization_enrollment_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name            TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    -- SHA-256 hex digest of the enrollment key (64 hex chars). Never plaintext.
    key_hash        TEXT NOT NULL UNIQUE CHECK (char_length(key_hash) = 64),
    key_prefix      TEXT NOT NULL CHECK (char_length(key_prefix) = 8),
    created_by      UUID REFERENCES auth.users (id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    last_used_at    TIMESTAMPTZ,
    use_count       INT NOT NULL DEFAULT 0,
    CONSTRAINT chk_enrollment_key_expiry CHECK (
        expires_at IS NULL OR expires_at > created_at
    )
);

CREATE INDEX idx_enrollment_keys_org ON organization_enrollment_keys (organization_id, created_at DESC);

ALTER TABLE organization_enrollment_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY enrollment_keys_select ON organization_enrollment_keys
    FOR SELECT TO authenticated
    USING (
        NOT auth_is_device()
        AND auth_has_role(organization_id, 'administrator')
    );

-- Creation/rotation/revocation happen through the service-role API route so the
-- plaintext key is only ever returned to the creating administrator.

-- ============================================================
-- AUTOMATIC DEVICE ENROLLMENT
-- Called by the `enroll-device` Edge Function with the service role.
--
-- Idempotent on (organization_id, install_id): a retried enrollment after a
-- transient network failure returns the same device instead of creating a
-- duplicate. Returns a result code the Edge Function maps to JSON.
-- ============================================================
CREATE OR REPLACE FUNCTION enroll_device_with_key(
    p_key_hash       TEXT,
    p_install_id     UUID,
    p_device_id      UUID,
    p_hostname       TEXT,
    p_os             TEXT,
    p_agent_version  TEXT,
    p_api_key_hash   TEXT,
    p_api_key_prefix TEXT
)
RETURNS TABLE (
    result            TEXT,
    device_id         UUID,
    organization_id   UUID,
    enrollment_status TEXT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_key      organization_enrollment_keys;
    v_device   devices;
    v_auto     BOOLEAN;
    v_status   enrollment_status;
    v_name     TEXT;
BEGIN
    SELECT * INTO v_key
    FROM organization_enrollment_keys
    WHERE key_hash = p_key_hash
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'invalid_key'::TEXT, NULL::UUID, NULL::UUID, NULL::TEXT;
        RETURN;
    END IF;

    IF v_key.revoked_at IS NOT NULL THEN
        RETURN QUERY SELECT 'key_revoked'::TEXT, NULL::UUID, NULL::UUID, NULL::TEXT;
        RETURN;
    END IF;

    IF v_key.expires_at IS NOT NULL AND v_key.expires_at <= now() THEN
        RETURN QUERY SELECT 'key_expired'::TEXT, NULL::UUID, NULL::UUID, NULL::TEXT;
        RETURN;
    END IF;

    SELECT COALESCE(s.auto_authorize_devices, FALSE) INTO v_auto
    FROM organization_settings s
    WHERE s.organization_id = v_key.organization_id;

    v_name := LEFT(COALESCE(NULLIF(TRIM(p_hostname), ''), 'Windows device'), 120);

    SELECT * INTO v_device
    FROM devices d
    WHERE d.organization_id = v_key.organization_id
      AND d.install_id = p_install_id
    FOR UPDATE;

    IF FOUND THEN
        IF v_device.enrollment_status = 'revoked' THEN
            RETURN QUERY SELECT 'device_revoked'::TEXT, v_device.id, v_device.organization_id,
                                v_device.enrollment_status::TEXT;
            RETURN;
        END IF;

        -- Retry/re-enrollment: refresh credentials and telemetry, keep lifecycle
        -- state (an unauthorized or suspended device stays that way).
        UPDATE devices SET
            api_key_hash     = p_api_key_hash,
            api_key_prefix   = LEFT(p_api_key_prefix, 8),
            hostname         = LEFT(p_hostname, 253),
            operating_system = LEFT(p_os, 100),
            agent_version    = LEFT(p_agent_version, 40),
            last_seen_at     = now(),
            updated_at       = now()
        WHERE id = v_device.id;

        UPDATE organization_enrollment_keys
        SET last_used_at = now(), use_count = use_count + 1
        WHERE id = v_key.id;

        INSERT INTO audit_events (organization_id, actor_type, actor_id, action,
                                  target_type, target_id, metadata)
        VALUES (v_key.organization_id, 'device', v_device.id, 'device.enrollment_refreshed',
                'device', v_device.id,
                jsonb_build_object('install_id', p_install_id, 'key_prefix', v_key.key_prefix));

        RETURN QUERY SELECT 'ok'::TEXT, v_device.id, v_device.organization_id,
                            v_device.enrollment_status::TEXT;
        RETURN;
    END IF;

    v_status := CASE WHEN v_auto THEN 'enrolled'::enrollment_status
                     ELSE 'unauthorized'::enrollment_status END;

    INSERT INTO devices (
        id, organization_id, display_name, hostname, operating_system,
        agent_version, enrollment_status, api_key_hash, api_key_prefix,
        install_id, last_seen_at, enrolled_at, authorized_at, status_reason
    ) VALUES (
        p_device_id, v_key.organization_id, v_name, LEFT(p_hostname, 253),
        LEFT(p_os, 100), LEFT(p_agent_version, 40), v_status,
        p_api_key_hash, LEFT(p_api_key_prefix, 8), p_install_id, now(), now(),
        CASE WHEN v_auto THEN now() ELSE NULL END,
        CASE WHEN v_auto THEN NULL ELSE 'Awaiting administrator authorization' END
    )
    ON CONFLICT (id) DO NOTHING;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'device_exists'::TEXT, NULL::UUID, v_key.organization_id, NULL::TEXT;
        RETURN;
    END IF;

    UPDATE organization_enrollment_keys
    SET last_used_at = now(), use_count = use_count + 1
    WHERE id = v_key.id;

    INSERT INTO audit_events (organization_id, actor_type, actor_id, action,
                              target_type, target_id, metadata)
    VALUES (v_key.organization_id, 'device', p_device_id, 'device.enrolled',
            'device', p_device_id,
            jsonb_build_object(
                'install_id', p_install_id,
                'hostname', p_hostname,
                'operating_system', p_os,
                'auto_authorized', v_auto,
                'key_prefix', v_key.key_prefix
            ));

    RETURN QUERY SELECT 'ok'::TEXT, p_device_id, v_key.organization_id, v_status::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION enroll_device_with_key(TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enroll_device_with_key(TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- ============================================================
-- DEVICE TELEMETRY / HEARTBEAT
-- Reports hostname, OS, service state and execution context, and returns the
-- current lifecycle state plus the number of jobs waiting for this device.
-- ============================================================
CREATE OR REPLACE FUNCTION device_report(
    p_device_id         UUID,
    p_hostname          TEXT,
    p_os                TEXT,
    p_agent_version     TEXT,
    p_service_status    TEXT,
    p_is_elevated       BOOLEAN,
    p_execution_account TEXT
)
RETURNS TABLE (
    enrollment_status TEXT,
    last_seen_at      TIMESTAMPTZ,
    pending_jobs      INT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_status enrollment_status;
    v_seen   TIMESTAMPTZ;
    v_pending INT;
BEGIN
    UPDATE devices SET
        hostname          = LEFT(COALESCE(NULLIF(TRIM(p_hostname), ''), hostname), 253),
        operating_system  = LEFT(COALESCE(NULLIF(TRIM(p_os), ''), operating_system), 100),
        agent_version     = LEFT(COALESCE(p_agent_version, agent_version), 40),
        service_status    = LEFT(p_service_status, 40),
        is_elevated       = p_is_elevated,
        execution_account = LEFT(p_execution_account, 120),
        last_seen_at      = now(),
        updated_at        = now()
    WHERE devices.id = p_device_id
      AND devices.enrollment_status <> 'revoked'
    RETURNING devices.enrollment_status, devices.last_seen_at INTO v_status, v_seen;

    IF NOT FOUND THEN
        RETURN QUERY SELECT NULL::TEXT, NULL::TIMESTAMPTZ, 0;
        RETURN;
    END IF;

    IF v_status = 'enrolled' THEN
        SELECT COUNT(*)::INT INTO v_pending
        FROM jobs j
        WHERE j.device_id = p_device_id
          AND j.state IN ('queued', 'waiting_for_device')
          AND j.expires_at > now();
    ELSE
        v_pending := 0;
    END IF;

    RETURN QUERY SELECT v_status::TEXT, v_seen, v_pending;
END;
$$;

REVOKE ALL ON FUNCTION device_report(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION device_report(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT) TO service_role;



-- ============================================================
-- File: 008_terminal_sessions.sql
-- ============================================================
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



-- ============================================================
-- File: 009_rmm_core.sql
-- ============================================================
-- Migration: 009_rmm_core.sql
-- Description: Remote Monitoring & Management core.
--
-- Adds endpoint inventory, time-series telemetry, monitor definitions/results,
-- alerting, Windows event ingestion, software inventory, package management,
-- deployment policies/jobs, device groups and health scoring.
--
-- Design notes:
--  * All organisation-scoped tables carry organization_id and are protected by
--    RLS. The Windows agent never talks to PostgREST directly; it authenticates
--    through the agent-gateway Edge Function, which validates the device JWT and
--    calls the SECURITY DEFINER RPCs below with the service role.
--  * Telemetry rows are append-only. Growth is controlled by batched ingestion
--    (bounded payloads), BRIN + btree indexes and rmm_apply_retention().
--  * Agent-reported values are untrusted: every JSON payload is size-checked,
--    typed, truncated and rejected when malformed.
--  * Deployment jobs are persisted before dispatch and claimed atomically, so a
--    reconnect cannot execute the same package twice.

-- ============================================================
-- TYPES
-- ============================================================
CREATE TYPE device_group_type AS ENUM ('static', 'dynamic');
CREATE TYPE monitor_kind AS ENUM (
    'cpu', 'memory', 'disk', 'process', 'service', 'event_log', 'file',
    'directory', 'registry', 'powershell', 'ping', 'tcp', 'hardware', 'os',
    'custom_metric'
);
CREATE TYPE monitor_status AS ENUM ('ok', 'warning', 'critical', 'unknown', 'error');
CREATE TYPE monitor_severity AS ENUM ('info', 'warning', 'critical');
CREATE TYPE alert_status AS ENUM ('open', 'acknowledged', 'resolved');
CREATE TYPE software_change_type AS ENUM ('installed', 'updated', 'removed', 'detected');
CREATE TYPE package_format AS ENUM ('msi', 'exe');
CREATE TYPE package_approval_status AS ENUM ('draft', 'pending', 'approved', 'rejected');
CREATE TYPE deployment_target_type AS ENUM ('device', 'group');
CREATE TYPE deployment_operation AS ENUM ('install', 'update', 'repair', 'uninstall', 'rollback');
CREATE TYPE deployment_state AS ENUM (
    'pending', 'queued', 'downloading', 'validating', 'installing', 'verifying',
    'succeeded', 'failed', 'cancelled', 'expired', 'reboot_required', 'blocked'
);

-- ============================================================
-- AGENT HEALTH / CHECK-IN COLUMNS ON DEVICES
-- ============================================================
ALTER TABLE devices
    ADD COLUMN last_heartbeat_at        TIMESTAMPTZ,
    ADD COLUMN heartbeat_failures       INT NOT NULL DEFAULT 0 CHECK (heartbeat_failures >= 0),
    ADD COLUMN reconnect_attempts       INT NOT NULL DEFAULT 0 CHECK (reconnect_attempts >= 0),
    ADD COLUMN pending_job_count        INT NOT NULL DEFAULT 0 CHECK (pending_job_count >= 0),
    ADD COLUMN last_metric_at           TIMESTAMPTZ,
    ADD COLUMN last_inventory_at        TIMESTAMPTZ,
    ADD COLUMN last_software_scan_at    TIMESTAMPTZ,
    ADD COLUMN last_event_at            TIMESTAMPTZ,
    ADD COLUMN agent_update_required    BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN agent_restart_required   BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX idx_devices_heartbeat ON devices (last_heartbeat_at);

-- ============================================================
-- ORGANISATION RMM SETTINGS
-- ============================================================
ALTER TABLE organization_settings
    ADD COLUMN offline_after_seconds           INT NOT NULL DEFAULT 300
        CHECK (offline_after_seconds BETWEEN 60 AND 86400),
    ADD COLUMN metrics_interval_seconds        INT NOT NULL DEFAULT 60
        CHECK (metrics_interval_seconds BETWEEN 10 AND 3600),
    ADD COLUMN inventory_interval_seconds      INT NOT NULL DEFAULT 21600
        CHECK (inventory_interval_seconds BETWEEN 300 AND 604800),
    ADD COLUMN software_scan_interval_seconds  INT NOT NULL DEFAULT 21600
        CHECK (software_scan_interval_seconds BETWEEN 300 AND 604800),
    ADD COLUMN event_scan_interval_seconds     INT NOT NULL DEFAULT 300
        CHECK (event_scan_interval_seconds BETWEEN 60 AND 86400),
    ADD COLUMN metrics_retention_days          INT NOT NULL DEFAULT 30
        CHECK (metrics_retention_days BETWEEN 1 AND 3650),
    ADD COLUMN monitor_results_retention_days  INT NOT NULL DEFAULT 30
        CHECK (monitor_results_retention_days BETWEEN 1 AND 3650),
    ADD COLUMN event_retention_days            INT NOT NULL DEFAULT 30
        CHECK (event_retention_days BETWEEN 1 AND 3650),
    ADD COLUMN deployment_output_retention_days INT NOT NULL DEFAULT 30
        CHECK (deployment_output_retention_days BETWEEN 1 AND 3650),
    ADD COLUMN deployment_concurrency_limit    INT NOT NULL DEFAULT 5
        CHECK (deployment_concurrency_limit BETWEEN 1 AND 100),
    ADD COLUMN allow_custom_powershell_monitors BOOLEAN NOT NULL DEFAULT FALSE,
    -- Windows Security log collection is opt-in and must be explicitly
    -- authorised; the default filters are still applied when enabled.
    ADD COLUMN allow_security_event_collection BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN allow_service_recovery         BOOLEAN NOT NULL DEFAULT FALSE,
    -- Minimum seconds between two automated recovery actions for the same
    -- service on the same device; prevents restart loops.
    ADD COLUMN service_recovery_cooldown_seconds INT NOT NULL DEFAULT 600
        CHECK (service_recovery_cooldown_seconds BETWEEN 60 AND 86400),
    ADD COLUMN max_event_bytes_per_scan        INT NOT NULL DEFAULT 1048576
        CHECK (max_event_bytes_per_scan BETWEEN 4096 AND 16777216);

-- ============================================================
-- DEVICE GROUPS
-- ============================================================
CREATE TABLE device_groups (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name            TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    description     TEXT CHECK (char_length(description) <= 500),
    group_type      device_group_type NOT NULL DEFAULT 'static',
    -- Dynamic rule document, e.g.
    -- {"match":"all","rules":[{"field":"os","op":"contains","value":"Windows 11"}]}
    dynamic_rules   JSONB NOT NULL DEFAULT '{}'::JSONB
        CHECK (pg_column_size(dynamic_rules) <= 16384),
    created_by      UUID REFERENCES auth.users (id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name)
);

CREATE INDEX idx_device_groups_org ON device_groups (organization_id);

CREATE TABLE device_group_members (
    group_id    UUID NOT NULL REFERENCES device_groups (id) ON DELETE CASCADE,
    device_id   UUID NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, device_id)
);

CREATE INDEX idx_group_members_device ON device_group_members (device_id);

CREATE TRIGGER trg_device_groups_updated_at
    BEFORE UPDATE ON device_groups
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- GENERAL GUARD: device and organisation must match
-- ============================================================
CREATE OR REPLACE FUNCTION rmm_assert_device_org()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM devices d
        WHERE d.id = NEW.device_id
          AND d.organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'device % does not belong to organization %',
            NEW.device_id, NEW.organization_id;
    END IF;
    RETURN NEW;
END;
$$;

-- Bounded JSON guard used for agent-supplied payloads.
CREATE OR REPLACE FUNCTION rmm_json_array_size(p_value JSONB)
RETURNS INT LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN jsonb_typeof(p_value) = 'array' THEN jsonb_array_length(p_value) ELSE 0 END;
$$;

-- ============================================================
-- HARDWARE / OS / NETWORK INVENTORY
-- ============================================================
CREATE TABLE device_inventory (
    device_id       UUID PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    hardware        JSONB NOT NULL DEFAULT '{}'::JSONB
        CHECK (pg_column_size(hardware) <= 65536),
    os              JSONB NOT NULL DEFAULT '{}'::JSONB
        CHECK (pg_column_size(os) <= 32768),
    network         JSONB NOT NULL DEFAULT '{}'::JSONB
        CHECK (pg_column_size(network) <= 65536),
    -- Agent-reported quality flags (partial collection, permission denied...)
    data_quality    JSONB NOT NULL DEFAULT '{}'::JSONB
        CHECK (pg_column_size(data_quality) <= 8192),
    collected_at    TIMESTAMPTZ NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_device_inventory_org ON device_inventory (organization_id);
CREATE TRIGGER trg_inventory_device_org
    BEFORE INSERT OR UPDATE ON device_inventory
    FOR EACH ROW EXECUTE FUNCTION rmm_assert_device_org();
CREATE TRIGGER trg_inventory_updated_at
    BEFORE UPDATE ON device_inventory
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE device_inventory_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id       UUID NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    content_hash    TEXT NOT NULL CHECK (char_length(content_hash) = 32),
    hardware        JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (pg_column_size(hardware) <= 65536),
    os              JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (pg_column_size(os) <= 32768),
    network         JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (pg_column_size(network) <= 65536),
    collected_at    TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_inventory_snapshots_device
    ON device_inventory_snapshots (device_id, collected_at DESC);
CREATE TRIGGER trg_inventory_snapshot_org
    BEFORE INSERT ON device_inventory_snapshots
    FOR EACH ROW EXECUTE FUNCTION rmm_assert_device_org();

-- ============================================================
-- TIME-SERIES METRICS
-- ============================================================
CREATE TABLE device_metrics (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    device_id       UUID NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    metric          TEXT NOT NULL CHECK (char_length(metric) BETWEEN 1 AND 80),
    value           DOUBLE PRECISION NOT NULL,
    dimensions      JSONB NOT NULL DEFAULT '{}'::JSONB
        CHECK (pg_column_size(dimensions) <= 2048),
    collected_at    TIMESTAMPTZ NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Query path: latest + ranges for one device/metric.
CREATE INDEX idx_metrics_device_metric
    ON device_metrics (device_id, metric, collected_at DESC);
-- Retention sweep / fleet-wide ranges.
CREATE INDEX idx_metrics_collected_brin ON device_metrics USING BRIN (collected_at);
CREATE INDEX idx_metrics_org_time ON device_metrics (organization_id, collected_at DESC);

CREATE TRIGGER trg_metrics_device_org
    BEFORE INSERT ON device_metrics
    FOR EACH ROW EXECUTE FUNCTION rmm_assert_device_org();

-- ============================================================
-- MONITORS
-- ============================================================
CREATE TABLE monitors (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name                TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
    kind                monitor_kind NOT NULL,
    -- Scope: exactly one of device_id (single endpoint), group_id (group) or
    -- neither (whole organisation).
    device_id           UUID REFERENCES devices (id) ON DELETE CASCADE,
    group_id            UUID REFERENCES device_groups (id) ON DELETE CASCADE,
    config              JSONB NOT NULL DEFAULT '{}'::JSONB
        CHECK (pg_column_size(config) <= 16384),
    interval_seconds    INT NOT NULL DEFAULT 60 CHECK (interval_seconds BETWEEN 15 AND 86400),
    timeout_seconds     INT NOT NULL DEFAULT 30 CHECK (timeout_seconds BETWEEN 1 AND 600),
    severity            monitor_severity NOT NULL DEFAULT 'warning',
    -- Number of consecutive breaching samples required before alerting.
    breach_samples      INT NOT NULL DEFAULT 1 CHECK (breach_samples BETWEEN 1 AND 60),
    recovery_samples    INT NOT NULL DEFAULT 1 CHECK (recovery_samples BETWEEN 1 AND 60),
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    -- Service recovery is only permitted when the organisation allows it and
    -- the monitor explicitly opts in.
    auto_recovery       BOOLEAN NOT NULL DEFAULT FALSE,
    recovery_action     JSONB NOT NULL DEFAULT '{}'::JSONB
        CHECK (pg_column_size(recovery_action) <= 4096),
    created_by          UUID REFERENCES auth.users (id),
    updated_by          UUID REFERENCES auth.users (id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_monitor_single_scope CHECK (NOT (device_id IS NOT NULL AND group_id IS NOT NULL)),
    CONSTRAINT chk_recovery_kind CHECK (NOT auto_recovery OR kind IN ('service', 'process'))
);

CREATE INDEX idx_monitors_org ON monitors (organization_id, enabled);
CREATE INDEX idx_monitors_device ON monitors (device_id) WHERE device_id IS NOT NULL;
CREATE INDEX idx_monitors_group ON monitors (group_id) WHERE group_id IS NOT NULL;

CREATE TRIGGER trg_monitors_updated_at
    BEFORE UPDATE ON monitors
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE monitor_state (
    monitor_id          UUID NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    device_id           UUID NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    last_status         monitor_status NOT NULL DEFAULT 'unknown',
    consecutive_breaches INT NOT NULL DEFAULT 0,
    consecutive_oks     INT NOT NULL DEFAULT 0,
    last_value          DOUBLE PRECISION,
    last_message        TEXT CHECK (char_length(last_message) <= 2000),
    last_run_at         TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (monitor_id, device_id)
);

CREATE TABLE monitor_results (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    monitor_id      UUID NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    device_id       UUID NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    status          monitor_status NOT NULL,
    value           DOUBLE PRECISION,
    message         TEXT CHECK (char_length(message) <= 2000),
    details         JSONB NOT NULL DEFAULT '{}'::JSONB
        CHECK (pg_column_size(details) <= 16384),
    duration_ms     INT CHECK (duration_ms >= 0 AND duration_ms <= 600000),
    error           TEXT CHECK (char_length(error) <= 2000),
    observed_at     TIMESTAMPTZ NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_monitor_results_monitor
    ON monitor_results (monitor_id, observed_at DESC);
CREATE INDEX idx_monitor_results_device
    ON monitor_results (device_id, observed_at DESC);
CREATE INDEX idx_monitor_results_org_time
    ON monitor_results (organization_id, observed_at DESC);

CREATE TRIGGER trg_monitor_results_org
    BEFORE INSERT ON monitor_results
    FOR EACH ROW EXECUTE FUNCTION rmm_assert_device_org();

-- ============================================================
-- ALERTS
-- ============================================================
CREATE TABLE alerts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    device_id       UUID NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    monitor_id      UUID REFERENCES monitors (id) ON DELETE SET NULL,
    severity        monitor_severity NOT NULL,
    status          alert_status NOT NULL DEFAULT 'open',
    summary         TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
    details         JSONB NOT NULL DEFAULT '{}'::JSONB
        CHECK (pg_column_size(details) <= 16384),
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by UUID REFERENCES auth.users (id),
    resolved_at     TIMESTAMPTZ,
    resolved_by     UUID REFERENCES auth.users (id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one live alert per monitor/device pair.
CREATE UNIQUE INDEX uq_alerts_open_monitor
    ON alerts (monitor_id, device_id)
    WHERE status <> 'resolved' AND monitor_id IS NOT NULL;
CREATE INDEX idx_alerts_org_status ON alerts (organization_id, status, last_seen_at DESC);
CREATE INDEX idx_alerts_device ON alerts (device_id, status);

CREATE TRIGGER trg_alerts_updated_at
    BEFORE UPDATE ON alerts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE alert_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id    UUID NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL CHECK (char_length(event_type) <= 40),
    actor_type  actor_type NOT NULL DEFAULT 'system',
    actor_id    UUID,
    note        TEXT CHECK (char_length(note) <= 2000),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_alert_events_alert ON alert_events (alert_id, created_at);

-- ============================================================
-- WINDOWS EVENT LOG RECORDS
-- ============================================================
CREATE TABLE device_events (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    device_id       UUID NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    log_name        TEXT NOT NULL CHECK (char_length(log_name) BETWEEN 1 AND 128),
    provider        TEXT CHECK (char_length(provider) <= 256),
    event_id        INT,
    level           TEXT CHECK (char_length(level) <= 40),
    recorded_at     TIMESTAMPTZ,
    message         TEXT CHECK (char_length(message) <= 4000),
    -- Stable agent-generated identity used to make ingestion idempotent across
    -- reconnects and retries.
    dedupe_key      TEXT NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
    details         JSONB NOT NULL DEFAULT '{}'::JSONB
        CHECK (pg_column_size(details) <= 8192),
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (device_id, dedupe_key)
);

CREATE INDEX idx_device_events_device ON device_events (device_id, recorded_at DESC);
CREATE INDEX idx_device_events_org ON device_events (organization_id, recorded_at DESC);
CREATE INDEX idx_device_events_level ON device_events (organization_id, level, received_at DESC);

CREATE TRIGGER trg_device_events_org
    BEFORE INSERT ON device_events
    FOR EACH ROW EXECUTE FUNCTION rmm_assert_device_org();

CREATE TABLE agent_health_events (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    device_id       UUID NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL CHECK (char_length(event_type) <= 60),
    detail          TEXT CHECK (char_length(detail) <= 2000),
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_health_device ON agent_health_events (device_id, recorded_at DESC);

CREATE TRIGGER trg_agent_health_org
    BEFORE INSERT ON agent_health_events
    FOR EACH ROW EXECUTE FUNCTION rmm_assert_device_org();

-- ============================================================
-- SOFTWARE INVENTORY
-- ============================================================
CREATE TABLE device_software (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    device_id       UUID NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    -- Stable identity across scans: lower(name)|publisher|architecture.
    product_key     TEXT NOT NULL CHECK (char_length(product_key) BETWEEN 1 AND 400),
    name            TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 300),
    publisher       TEXT CHECK (char_length(publisher) <= 300),
    version         TEXT CHECK (char_length(version) <= 80),
    architecture    TEXT CHECK (char_length(architecture) <= 20),
    install_date    DATE,
    install_source  TEXT CHECK (char_length(install_source) <= 1000),
    product_code    TEXT CHECK (char_length(product_code) <= 100),
    scope           TEXT NOT NULL DEFAULT 'machine' CHECK (scope IN ('machine', 'user')),
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (device_id, product_key)
);

CREATE INDEX idx_device_software_device ON device_software (device_id, name);
CREATE INDEX idx_device_software_org ON device_software (organization_id, name);
CREATE INDEX idx_device_software_product ON device_software (organization_id, product_code);

CREATE TRIGGER trg_device_software_org
    BEFORE INSERT OR UPDATE ON device_software
    FOR EACH ROW EXECUTE FUNCTION rmm_assert_device_org();
CREATE TRIGGER trg_device_software_updated_at
    BEFORE UPDATE ON device_software
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE software_change_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    device_id       UUID NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    change_type     software_change_type NOT NULL,
    product_key     TEXT NOT NULL CHECK (char_length(product_key) BETWEEN 1 AND 400),
    name            TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 300),
    from_version    TEXT CHECK (char_length(from_version) <= 80),
    to_version      TEXT CHECK (char_length(to_version) <= 80),
    -- 'confirmed' means an audited management job caused the change;
    -- 'inferred' means it was derived by comparing inventory snapshots.
    source          TEXT NOT NULL DEFAULT 'inferred' CHECK (source IN ('confirmed', 'inferred')),
    deployment_job_id UUID,
    actor_user_id   UUID REFERENCES auth.users (id),
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_software_changes_device ON software_change_events (device_id, detected_at DESC);
CREATE INDEX idx_software_changes_org ON software_change_events (organization_id, detected_at DESC);

CREATE TRIGGER trg_software_changes_org
    BEFORE INSERT ON software_change_events
    FOR EACH ROW EXECUTE FUNCTION rmm_assert_device_org();

-- ============================================================
-- PACKAGE REPOSITORY
-- ============================================================
CREATE TABLE software_packages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name            TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
    description     TEXT CHECK (char_length(description) <= 2000),
    publisher       TEXT CHECK (char_length(publisher) <= 160),
    is_internal     BOOLEAN NOT NULL DEFAULT FALSE,
    visibility      TEXT NOT NULL DEFAULT 'organization'
        CHECK (visibility IN ('organization', 'private')),
    created_by      UUID REFERENCES auth.users (id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name)
);

CREATE INDEX idx_packages_org ON software_packages (organization_id);

CREATE TRIGGER trg_packages_updated_at
    BEFORE UPDATE ON software_packages
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE software_package_versions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    package_id          UUID NOT NULL REFERENCES software_packages (id) ON DELETE CASCADE,
    organization_id     UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    version             TEXT NOT NULL CHECK (char_length(version) BETWEEN 1 AND 60),
    package_format      package_format NOT NULL,
    architecture        TEXT NOT NULL DEFAULT 'x64' CHECK (architecture IN ('x64', 'x86', 'arm64', 'any')),
    supported_os        TEXT CHECK (char_length(supported_os) <= 300),
    -- Object path inside the private package storage bucket.
    storage_path        TEXT NOT NULL CHECK (
        char_length(storage_path) BETWEEN 1 AND 500
        AND storage_path NOT LIKE '%..%'
        AND storage_path NOT LIKE '/%'
    ),
    sha256              TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    file_size_bytes     BIGINT NOT NULL CHECK (file_size_bytes > 0 AND file_size_bytes <= 4294967296),
    signature_subject   TEXT CHECK (char_length(signature_subject) <= 500),
    signature_verified  BOOLEAN NOT NULL DEFAULT FALSE,
    install_args        TEXT CHECK (char_length(install_args) <= 2000),
    uninstall_args      TEXT CHECK (char_length(uninstall_args) <= 2000),
    repair_args         TEXT CHECK (char_length(repair_args) <= 2000),
    -- Detection document evaluated by the agent after installation, e.g.
    -- {"type":"msi_product_code","value":"{GUID}"} or
    -- {"type":"file_version","path":"C:\\Program Files\\...","min_version":"2.0"}.
    detection_rules     JSONB NOT NULL DEFAULT '{}'::JSONB
        CHECK (pg_column_size(detection_rules) <= 8192),
    prerequisites       JSONB NOT NULL DEFAULT '[]'::JSONB
        CHECK (pg_column_size(prerequisites) <= 16384),
    requires_reboot     BOOLEAN NOT NULL DEFAULT FALSE,
    approval_status     package_approval_status NOT NULL DEFAULT 'pending',
    approved_by         UUID REFERENCES auth.users (id),
    approved_at         TIMESTAMPTZ,
    published_at        TIMESTAMPTZ,
    -- Rollback is only advertised when a known recoverable version exists.
    rollback_version_id UUID REFERENCES software_package_versions (id),
    created_by          UUID REFERENCES auth.users (id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (package_id, version),
    CONSTRAINT chk_msi_silent CHECK (
        -- Documented MSI packages must carry an explicit silent install mode.
        package_format <> 'msi' OR install_args IS NULL OR install_args ILIKE '%/qn%'
        OR install_args ILIKE '%/quiet%'
    )
);

CREATE INDEX idx_package_versions_package ON software_package_versions (package_id, created_at DESC);
CREATE INDEX idx_package_versions_org ON software_package_versions (organization_id, approval_status);

CREATE TRIGGER trg_package_versions_updated_at
    BEFORE UPDATE ON software_package_versions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- DEPLOYMENT POLICIES AND JOBS
-- ============================================================
CREATE TABLE deployment_policies (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name                TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
    package_version_id  UUID NOT NULL REFERENCES software_package_versions (id) ON DELETE CASCADE,
    operation           deployment_operation NOT NULL DEFAULT 'install',
    target_type         deployment_target_type NOT NULL,
    target_device_id    UUID REFERENCES devices (id) ON DELETE CASCADE,
    target_group_id     UUID REFERENCES device_groups (id) ON DELETE CASCADE,
    schedule_at         TIMESTAMPTZ,
    -- {"days":[1,2,3,4,5],"start":"02:00","end":"04:00","timezone":"UTC"}
    maintenance_window  JSONB NOT NULL DEFAULT '{}'::JSONB
        CHECK (pg_column_size(maintenance_window) <= 4096),
    concurrency_limit   INT NOT NULL DEFAULT 5 CHECK (concurrency_limit BETWEEN 1 AND 100),
    max_attempts        INT NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 5),
    reboot_policy       TEXT NOT NULL DEFAULT 'never'
        CHECK (reboot_policy IN ('never', 'if_required', 'always')),
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    created_by          UUID REFERENCES auth.users (id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_policy_target CHECK (
        (target_type = 'device' AND target_device_id IS NOT NULL AND target_group_id IS NULL)
        OR (target_type = 'group' AND target_group_id IS NOT NULL AND target_device_id IS NULL)
    )
);

CREATE INDEX idx_deployment_policies_org ON deployment_policies (organization_id, enabled);

CREATE TRIGGER trg_deployment_policies_updated_at
    BEFORE UPDATE ON deployment_policies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE deployment_jobs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    device_id           UUID NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    package_version_id  UUID NOT NULL REFERENCES software_package_versions (id),
    policy_id           UUID REFERENCES deployment_policies (id) ON DELETE SET NULL,
    operation           deployment_operation NOT NULL DEFAULT 'install',
    state               deployment_state NOT NULL DEFAULT 'queued',
    progress            INT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    attempts            INT NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 10),
    max_attempts        INT NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 5),
    scheduled_for       TIMESTAMPTZ,
    claimed_at          TIMESTAMPTZ,
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    exit_code           INT,
    error_summary       TEXT CHECK (char_length(error_summary) <= 2000),
    stdout_text         TEXT CHECK (char_length(stdout_text) <= 65536),
    stderr_text         TEXT CHECK (char_length(stderr_text) <= 16384),
    reboot_required     BOOLEAN NOT NULL DEFAULT FALSE,
    rollback_available  BOOLEAN NOT NULL DEFAULT FALSE,
    requested_by        UUID REFERENCES auth.users (id),
    idempotency_key     TEXT CHECK (char_length(idempotency_key) <= 128),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_deployment_idempotency
    ON deployment_jobs (organization_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_deployment_jobs_device
    ON deployment_jobs (device_id, state, scheduled_for);
CREATE INDEX idx_deployment_jobs_org
    ON deployment_jobs (organization_id, created_at DESC);
-- Agent claim path.
CREATE INDEX idx_deployment_jobs_claim
    ON deployment_jobs (device_id, scheduled_for)
    WHERE state IN ('pending', 'queued');
CREATE INDEX idx_deployment_jobs_active
    ON deployment_jobs (organization_id, state)
    WHERE state IN ('downloading', 'validating', 'installing', 'verifying');

CREATE TRIGGER trg_deployment_jobs_updated_at
    BEFORE UPDATE ON deployment_jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_deployment_jobs_org
    BEFORE INSERT OR UPDATE ON deployment_jobs
    FOR EACH ROW EXECUTE FUNCTION rmm_assert_device_org();

CREATE TABLE deployment_attempts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID NOT NULL REFERENCES deployment_jobs (id) ON DELETE CASCADE,
    attempt_number  INT NOT NULL CHECK (attempt_number >= 1),
    state           deployment_state NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    exit_code       INT,
    output          TEXT CHECK (char_length(output) <= 32768),
    error_summary   TEXT CHECK (char_length(error_summary) <= 2000),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (job_id, attempt_number)
);

CREATE INDEX idx_deployment_attempts_job ON deployment_attempts (job_id, attempt_number);

CREATE TRIGGER trg_deployment_attempts_updated_at
    BEFORE UPDATE ON deployment_attempts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- TENANT CONSISTENCY GUARDS
-- ============================================================
CREATE OR REPLACE FUNCTION rmm_assert_monitor_org()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.device_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM devices WHERE id = NEW.device_id
          AND organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'monitor_device_org_mismatch';
    END IF;
    IF NEW.group_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM device_groups WHERE id = NEW.group_id
          AND organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'monitor_group_org_mismatch';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_monitors_org
    BEFORE INSERT OR UPDATE ON monitors
    FOR EACH ROW EXECUTE FUNCTION rmm_assert_monitor_org();

CREATE OR REPLACE FUNCTION rmm_assert_package_version_org()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM software_packages
        WHERE id = NEW.package_id AND organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'package_version_org_mismatch';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_package_versions_org
    BEFORE INSERT OR UPDATE ON software_package_versions
    FOR EACH ROW EXECUTE FUNCTION rmm_assert_package_version_org();

CREATE OR REPLACE FUNCTION rmm_assert_deployment_job_org()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM software_package_versions
        WHERE id = NEW.package_version_id AND organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'deployment_package_org_mismatch';
    END IF;
    IF NEW.policy_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM deployment_policies
        WHERE id = NEW.policy_id AND organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'deployment_policy_org_mismatch';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_deployment_jobs_org_check
    BEFORE INSERT OR UPDATE ON deployment_jobs
    FOR EACH ROW EXECUTE FUNCTION rmm_assert_deployment_job_org();

CREATE OR REPLACE FUNCTION rmm_assert_deployment_policy_org()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM software_package_versions
        WHERE id = NEW.package_version_id AND organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'policy_package_org_mismatch';
    END IF;
    IF NEW.target_device_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM devices
        WHERE id = NEW.target_device_id AND organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'policy_device_org_mismatch';
    END IF;
    IF NEW.target_group_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM device_groups
        WHERE id = NEW.target_group_id AND organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'policy_group_org_mismatch';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_deployment_policies_org
    BEFORE INSERT OR UPDATE ON deployment_policies
    FOR EACH ROW EXECUTE FUNCTION rmm_assert_deployment_policy_org();

-- ============================================================
-- GROUP MEMBERSHIP EXPANSION
-- ============================================================
CREATE OR REPLACE FUNCTION rmm_device_matches_group(p_device_id UUID, p_group_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_group  device_groups;
    v_device devices;
    v_inv    device_inventory;
    v_rule   JSONB;
    v_match  TEXT;
    v_field  TEXT;
    v_op     TEXT;
    v_value  TEXT;
    v_actual TEXT;
    v_ok     BOOLEAN;
    v_all    BOOLEAN;
BEGIN
    SELECT * INTO v_group FROM device_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RETURN FALSE; END IF;

    SELECT * INTO v_device FROM devices
    WHERE id = p_device_id AND organization_id = v_group.organization_id;
    IF NOT FOUND THEN RETURN FALSE; END IF;

    IF v_group.group_type = 'static' THEN
        RETURN EXISTS (
            SELECT 1 FROM device_group_members
            WHERE group_id = p_group_id AND device_id = p_device_id
        );
    END IF;

    SELECT * INTO v_inv FROM device_inventory WHERE device_id = p_device_id;

    v_match := lower(COALESCE(v_group.dynamic_rules ->> 'match', 'all'));
    IF v_match NOT IN ('all', 'any') THEN
        v_match := 'all';
    END IF;
    -- 'any' must start false, otherwise the empty OR seed would match.
    v_all := (v_match = 'all');

    IF jsonb_typeof(v_group.dynamic_rules -> 'rules') <> 'array' THEN
        RETURN FALSE;
    END IF;

    FOR v_rule IN SELECT * FROM jsonb_array_elements(v_group.dynamic_rules -> 'rules')
    LOOP
        v_field := lower(COALESCE(v_rule ->> 'field', ''));
        v_op := lower(COALESCE(v_rule ->> 'op', 'eq'));
        v_value := COALESCE(v_rule ->> 'value', '');

        v_actual := CASE v_field
            WHEN 'hostname' THEN COALESCE(v_device.hostname, '')
            WHEN 'display_name' THEN v_device.display_name
            WHEN 'os' THEN COALESCE(v_device.operating_system, '')
            WHEN 'os_version' THEN COALESCE(v_inv.os ->> 'version', '')
            WHEN 'os_build' THEN COALESCE(v_inv.os ->> 'build', '')
            WHEN 'agent_version' THEN COALESCE(v_device.agent_version, '')
            WHEN 'manufacturer' THEN COALESCE(v_inv.hardware ->> 'manufacturer', '')
            WHEN 'model' THEN COALESCE(v_inv.hardware ->> 'model', '')
            WHEN 'tag' THEN COALESCE(v_device.metadata -> 'tags', '[]'::JSONB)::TEXT
            ELSE NULL
        END;

        IF v_actual IS NULL THEN
            -- Unsupported field or missing data: a dynamic rule must not
            -- accidentally match every device.
            v_ok := FALSE;
        ELSE
            v_ok := CASE v_op
                WHEN 'eq' THEN lower(v_actual) = lower(v_value)
                WHEN 'neq' THEN lower(v_actual) <> lower(v_value)
                WHEN 'contains' THEN position(lower(v_value) in lower(v_actual)) > 0
                WHEN 'not_contains' THEN position(lower(v_value) in lower(v_actual)) = 0
                WHEN 'starts_with' THEN lower(v_actual) LIKE lower(v_value) || '%'
                WHEN 'in' THEN lower(v_actual) = ANY (
                    SELECT lower(TRIM(x)) FROM jsonb_array_elements_text(
                        CASE WHEN jsonb_typeof(v_rule -> 'values') = 'array'
                             THEN v_rule -> 'values' ELSE '[]'::JSONB END
                    ) AS x
                )
                ELSE FALSE
            END;
        END IF;

        IF v_match = 'any' THEN
            v_all := v_all OR v_ok;
        ELSE
            v_all := v_all AND v_ok;
        END IF;
    END LOOP;

    RETURN COALESCE(v_all, FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION rmm_group_device_ids(p_group_id UUID)
RETURNS SETOF UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_group device_groups;
    v_device RECORD;
BEGIN
    SELECT * INTO v_group FROM device_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RETURN; END IF;

    FOR v_device IN
        SELECT d.id FROM devices d
        WHERE d.organization_id = v_group.organization_id
          AND d.enrollment_status = 'enrolled'
    LOOP
        IF rmm_device_matches_group(v_device.id, p_group_id) THEN
            RETURN NEXT v_device.id;
        END IF;
    END LOOP;
END;
$$;

-- ============================================================
-- AGENT HEARTBEAT (extended)
-- ============================================================
CREATE OR REPLACE FUNCTION rmm_heartbeat(
    p_device_id UUID,
    p_hostname TEXT,
    p_os TEXT,
    p_agent_version TEXT,
    p_service_status TEXT,
    p_is_elevated BOOLEAN,
    p_execution_account TEXT,
    p_connection_failures INT DEFAULT 0,
    p_reconnect_attempts INT DEFAULT 0,
    p_restart_required BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
    enrollment_status TEXT,
    pending_jobs INT,
    pending_deployments INT,
    server_time TIMESTAMPTZ,
    offline_after_seconds INT,
    metrics_interval_seconds INT,
    inventory_interval_seconds INT,
    software_scan_interval_seconds INT,
    event_scan_interval_seconds INT,
    allow_custom_powershell_monitors BOOLEAN,
    allow_security_event_collection BOOLEAN,
    allow_service_recovery BOOLEAN,
    service_recovery_cooldown_seconds INT,
    max_event_bytes_per_scan INT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_device devices;
    v_settings organization_settings;
BEGIN
    SELECT * INTO v_device FROM devices WHERE id = p_device_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'device_not_found';
    END IF;

    UPDATE devices SET
        last_seen_at        = now(),
        last_heartbeat_at   = now(),
        hostname            = LEFT(COALESCE(NULLIF(TRIM(p_hostname), ''), hostname), 253),
        operating_system    = LEFT(COALESCE(NULLIF(TRIM(p_os), ''), operating_system), 100),
        agent_version       = LEFT(COALESCE(NULLIF(TRIM(p_agent_version), ''), agent_version), 40),
        service_status      = LEFT(COALESCE(NULLIF(TRIM(p_service_status), ''), service_status), 40),
        is_elevated         = COALESCE(p_is_elevated, is_elevated),
        execution_account   = LEFT(COALESCE(NULLIF(TRIM(p_execution_account), ''), execution_account), 120),
        heartbeat_failures  = GREATEST(COALESCE(p_connection_failures, 0), 0),
        reconnect_attempts  = GREATEST(COALESCE(p_reconnect_attempts, 0), 0),
        agent_restart_required = COALESCE(p_restart_required, FALSE),
        updated_at          = now()
    WHERE id = p_device_id;

    SELECT * INTO v_settings FROM organization_settings
    WHERE organization_id = v_device.organization_id;

    -- Heartbeat restores online state after a communication outage.
    IF v_device.enrollment_status = 'enrolled' AND v_device.service_status = 'offline' THEN
        INSERT INTO agent_health_events (organization_id, device_id, event_type, detail)
        VALUES (v_device.organization_id, p_device_id, 'agent.reconnected', 'Heartbeat received after outage');
    END IF;

    RETURN QUERY SELECT
        v_device.enrollment_status::TEXT,
        (SELECT COUNT(*)::INT FROM jobs j
          WHERE j.device_id = p_device_id
            AND j.state IN ('queued', 'waiting_for_device')
            AND j.expires_at > now()),
        (SELECT COUNT(*)::INT FROM deployment_jobs dj
          WHERE dj.device_id = p_device_id
            AND dj.state IN ('pending', 'queued')),
        now(),
        COALESCE(v_settings.offline_after_seconds, 300),
        COALESCE(v_settings.metrics_interval_seconds, 60),
        COALESCE(v_settings.inventory_interval_seconds, 21600),
        COALESCE(v_settings.software_scan_interval_seconds, 21600),
        COALESCE(v_settings.event_scan_interval_seconds, 300),
        COALESCE(v_settings.allow_custom_powershell_monitors, FALSE),
        COALESCE(v_settings.allow_security_event_collection, FALSE),
        COALESCE(v_settings.allow_service_recovery, FALSE),
        COALESCE(v_settings.service_recovery_cooldown_seconds, 600),
        COALESCE(v_settings.max_event_bytes_per_scan, 1048576);
END;
$$;

-- ============================================================
-- INGEST: INVENTORY
-- ============================================================
CREATE OR REPLACE FUNCTION rmm_ingest_inventory(
    p_device_id UUID,
    p_hardware JSONB,
    p_os JSONB,
    p_network JSONB,
    p_data_quality JSONB,
    p_collected_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_device devices;
    v_hash TEXT;
    v_previous TEXT;
    v_snapshot BOOLEAN := FALSE;
BEGIN
    SELECT * INTO v_device FROM devices
    WHERE id = p_device_id AND enrollment_status = 'enrolled';
    IF NOT FOUND THEN RAISE EXCEPTION 'device_not_authorized'; END IF;

    IF p_hardware IS NULL OR jsonb_typeof(p_hardware) <> 'object'
       OR jsonb_typeof(COALESCE(p_os, '{}'::JSONB)) <> 'object'
       OR jsonb_typeof(COALESCE(p_network, '{}'::JSONB)) <> 'object' THEN
        RAISE EXCEPTION 'invalid_inventory_payload';
    END IF;
    IF pg_column_size(p_hardware) > 65536
       OR pg_column_size(COALESCE(p_os, '{}'::JSONB)) > 32768
       OR pg_column_size(COALESCE(p_network, '{}'::JSONB)) > 65536 THEN
        RAISE EXCEPTION 'inventory_payload_too_large';
    END IF;
    IF p_collected_at > now() + interval '1 hour'
       OR p_collected_at < now() - interval '30 days' THEN
        RAISE EXCEPTION 'invalid_collected_at';
    END IF;

    v_hash := md5(p_hardware::TEXT || COALESCE(p_os, '{}'::JSONB)::TEXT
                  || COALESCE(p_network, '{}'::JSONB)::TEXT);

    SELECT content_hash INTO v_previous
    FROM device_inventory_snapshots
    WHERE device_id = p_device_id
    ORDER BY collected_at DESC
    LIMIT 1;
    v_snapshot := (v_previous IS DISTINCT FROM v_hash);

    INSERT INTO device_inventory AS di
        (device_id, organization_id, hardware, os, network, data_quality, collected_at)
    VALUES
        (p_device_id, v_device.organization_id, p_hardware,
         COALESCE(p_os, '{}'::JSONB), COALESCE(p_network, '{}'::JSONB),
         COALESCE(p_data_quality, '{}'::JSONB), p_collected_at)
    ON CONFLICT (device_id) DO UPDATE SET
        hardware = EXCLUDED.hardware,
        os = EXCLUDED.os,
        network = EXCLUDED.network,
        data_quality = EXCLUDED.data_quality,
        collected_at = EXCLUDED.collected_at,
        received_at = now(),
        updated_at = now();

    IF v_snapshot THEN
        INSERT INTO device_inventory_snapshots
            (device_id, organization_id, content_hash, hardware, os, network, collected_at)
        VALUES
            (p_device_id, v_device.organization_id, v_hash, p_hardware,
             COALESCE(p_os, '{}'::JSONB), COALESCE(p_network, '{}'::JSONB), p_collected_at);

        -- Keep the newest 50 snapshots per device.
        DELETE FROM device_inventory_snapshots
        WHERE id IN (
            SELECT id FROM device_inventory_snapshots
            WHERE device_id = p_device_id
            ORDER BY collected_at DESC
            OFFSET 50
        );
    END IF;

    UPDATE devices SET last_inventory_at = now() WHERE id = p_device_id;

    RETURN jsonb_build_object('ok', TRUE, 'snapshot_created', v_snapshot, 'collected_at', p_collected_at);
END;
$$;

-- ============================================================
-- INGEST: METRICS (bounded batch)
-- ============================================================
CREATE OR REPLACE FUNCTION rmm_ingest_metrics(
    p_device_id UUID,
    p_samples JSONB
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_device devices;
    v_count INT;
    v_inserted INT := 0;
    v_sample JSONB;
    v_metric TEXT;
    v_value DOUBLE PRECISION;
    v_collected TIMESTAMPTZ;
BEGIN
    SELECT * INTO v_device FROM devices
    WHERE id = p_device_id AND enrollment_status = 'enrolled';
    IF NOT FOUND THEN RAISE EXCEPTION 'device_not_authorized'; END IF;

    IF jsonb_typeof(p_samples) <> 'array' THEN
        RAISE EXCEPTION 'invalid_metrics_payload';
    END IF;
    v_count := jsonb_array_length(p_samples);
    IF v_count = 0 THEN
        RETURN jsonb_build_object('inserted', 0);
    END IF;
    IF v_count > 500 THEN
        RAISE EXCEPTION 'metrics_batch_too_large';
    END IF;
    IF pg_column_size(p_samples) > 262144 THEN
        RAISE EXCEPTION 'metrics_payload_too_large';
    END IF;

    -- Per-device ingestion ceiling (protects the table from a runaway agent).
    IF (SELECT COUNT(*) FROM device_metrics
        WHERE device_id = p_device_id
          AND received_at > now() - interval '1 minute') + v_count > 3000 THEN
        RAISE EXCEPTION 'metrics_rate_limit_exceeded';
    END IF;

    FOR v_sample IN SELECT * FROM jsonb_array_elements(p_samples)
    LOOP
        v_metric := LEFT(COALESCE(v_sample ->> 'metric', ''), 80);
        IF v_metric !~ '^[a-z0-9_.-]{1,80}$' THEN
            RAISE EXCEPTION 'invalid_metric_name';
        END IF;
        IF jsonb_typeof(v_sample -> 'value') NOT IN ('number') THEN
            RAISE EXCEPTION 'invalid_metric_value';
        END IF;
        v_value := (v_sample ->> 'value')::DOUBLE PRECISION;
        IF v_value = 'NaN'::DOUBLE PRECISION OR v_value IN ('Infinity'::DOUBLE PRECISION, '-Infinity'::DOUBLE PRECISION) THEN
            RAISE EXCEPTION 'invalid_metric_value';
        END IF;

        v_collected := COALESCE((v_sample ->> 'collected_at')::TIMESTAMPTZ, now());
        IF v_collected > now() + interval '1 hour' OR v_collected < now() - interval '7 days' THEN
            RAISE EXCEPTION 'invalid_metric_timestamp';
        END IF;

        INSERT INTO device_metrics
            (organization_id, device_id, metric, value, dimensions, collected_at)
        VALUES
            (v_device.organization_id, p_device_id, v_metric, v_value,
             CASE WHEN jsonb_typeof(v_sample -> 'dimensions') = 'object'
                  AND pg_column_size(v_sample -> 'dimensions') <= 2048
                  THEN v_sample -> 'dimensions' ELSE '{}'::JSONB END,
             v_collected);
        v_inserted := v_inserted + 1;
    END LOOP;

    UPDATE devices SET last_metric_at = now() WHERE id = p_device_id;
    RETURN jsonb_build_object('inserted', v_inserted);
END;
$$;

-- ============================================================
-- INGEST: WINDOWS EVENT LOG
-- ============================================================
CREATE OR REPLACE FUNCTION rmm_ingest_events(
    p_device_id UUID,
    p_events JSONB
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_device devices;
    v_count INT;
    v_event JSONB;
    v_inserted INT;
    v_total INT := 0;
BEGIN
    SELECT * INTO v_device FROM devices
    WHERE id = p_device_id AND enrollment_status = 'enrolled';
    IF NOT FOUND THEN RAISE EXCEPTION 'device_not_authorized'; END IF;

    IF jsonb_typeof(p_events) <> 'array' THEN
        RAISE EXCEPTION 'invalid_events_payload';
    END IF;
    v_count := jsonb_array_length(p_events);
    IF v_count = 0 THEN RETURN jsonb_build_object('inserted', 0); END IF;
    IF v_count > 200 OR pg_column_size(p_events) > 1048576 THEN
        RAISE EXCEPTION 'events_batch_too_large';
    END IF;

    FOR v_event IN SELECT * FROM jsonb_array_elements(p_events)
    LOOP
        IF COALESCE(v_event ->> 'log_name', '') = ''
           OR COALESCE(v_event ->> 'dedupe_key', '') = '' THEN
            RAISE EXCEPTION 'invalid_event';
        END IF;

        INSERT INTO device_events
            (organization_id, device_id, log_name, provider, event_id, level,
             recorded_at, message, dedupe_key, details)
        VALUES
            (v_device.organization_id, p_device_id,
             LEFT(v_event ->> 'log_name', 128),
             LEFT(NULLIF(v_event ->> 'provider', ''), 256),
             CASE WHEN (v_event ->> 'event_id') ~ '^-?[0-9]{1,6}$'
                  THEN (v_event ->> 'event_id')::INT ELSE NULL END,
             LEFT(NULLIF(v_event ->> 'level', ''), 40),
             NULLIF(v_event ->> 'recorded_at', '')::TIMESTAMPTZ,
             LEFT(NULLIF(v_event ->> 'message', ''), 4000),
             LEFT(v_event ->> 'dedupe_key', 200),
             CASE WHEN jsonb_typeof(v_event -> 'details') = 'object'
                  THEN v_event -> 'details' ELSE '{}'::JSONB END)
        ON CONFLICT (device_id, dedupe_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        v_total := v_total + v_inserted;
    END LOOP;

    UPDATE devices SET last_event_at = now() WHERE id = p_device_id;
    RETURN jsonb_build_object('inserted', v_total);
END;
$$;

-- ============================================================
-- INGEST: SOFTWARE INVENTORY (diffing)
-- ============================================================
CREATE OR REPLACE FUNCTION rmm_ingest_software(
    p_device_id UUID,
    p_apps JSONB,
    p_collected_at TIMESTAMPTZ DEFAULT now()
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_device devices;
    v_count INT;
    v_app JSONB;
    v_added INT := 0;
    v_updated INT := 0;
    v_removed INT := 0;
    v_key TEXT;
    v_name TEXT;
    v_publisher TEXT;
    v_version TEXT;
    v_arch TEXT;
    v_previous device_software;
    v_existed BOOLEAN;
BEGIN
    SELECT * INTO v_device FROM devices
    WHERE id = p_device_id AND enrollment_status = 'enrolled';
    IF NOT FOUND THEN RAISE EXCEPTION 'device_not_authorized'; END IF;

    IF jsonb_typeof(p_apps) <> 'array' THEN
        RAISE EXCEPTION 'invalid_software_payload';
    END IF;
    v_count := jsonb_array_length(p_apps);
    IF v_count > 3000 OR pg_column_size(p_apps) > 2097152 THEN
        RAISE EXCEPTION 'software_payload_too_large';
    END IF;
    IF p_collected_at > now() + interval '1 hour'
       OR p_collected_at < now() - interval '30 days' THEN
        RAISE EXCEPTION 'invalid_collected_at';
    END IF;

    -- Snapshot the scan in a temp set so removed products can be derived.
    CREATE TEMP TABLE IF NOT EXISTS rmm_scan_apps (
        product_key TEXT PRIMARY KEY,
        name TEXT,
        publisher TEXT,
        version TEXT,
        architecture TEXT
    ) ON COMMIT DROP;
    TRUNCATE rmm_scan_apps;

    FOR v_app IN SELECT * FROM jsonb_array_elements(p_apps)
    LOOP
        v_key := LEFT(COALESCE(v_app ->> 'product_key', ''), 400);
        v_name := LEFT(COALESCE(v_app ->> 'name', ''), 300);
        IF v_key = '' OR v_name = '' THEN
            CONTINUE; -- malformed entries are skipped, never trusted
        END IF;
        v_publisher := LEFT(NULLIF(v_app ->> 'publisher', ''), 300);
        v_version := LEFT(NULLIF(v_app ->> 'version', ''), 80);
        v_arch := LEFT(NULLIF(v_app ->> 'architecture', ''), 20);

        INSERT INTO rmm_scan_apps VALUES (v_key, v_name, v_publisher, v_version, v_arch)
        ON CONFLICT (product_key) DO NOTHING;

        SELECT * INTO v_previous FROM device_software
        WHERE device_id = p_device_id AND product_key = v_key;
        v_existed := FOUND;

        INSERT INTO device_software AS ds
            (organization_id, device_id, product_key, name, publisher, version,
             architecture, install_date, install_source, product_code, scope, detected_at)
        VALUES
            (v_device.organization_id, p_device_id, v_key, v_name, v_publisher, v_version,
             v_arch,
             NULLIF(v_app ->> 'install_date', '')::DATE,
             LEFT(NULLIF(v_app ->> 'install_source', ''), 1000),
             LEFT(NULLIF(v_app ->> 'product_code', ''), 100),
             CASE WHEN v_app ->> 'scope' = 'user' THEN 'user' ELSE 'machine' END,
             p_collected_at)
        ON CONFLICT (device_id, product_key) DO UPDATE SET
            name = EXCLUDED.name,
            publisher = EXCLUDED.publisher,
            version = EXCLUDED.version,
            architecture = EXCLUDED.architecture,
            install_date = EXCLUDED.install_date,
            install_source = EXCLUDED.install_source,
            product_code = EXCLUDED.product_code,
            scope = EXCLUDED.scope,
            detected_at = EXCLUDED.detected_at,
            updated_at = now();

        IF NOT v_existed THEN
            v_added := v_added + 1;
            INSERT INTO software_change_events
                (organization_id, device_id, change_type, product_key, name,
                 to_version, source, detected_at)
            VALUES
                (v_device.organization_id, p_device_id, 'detected', v_key, v_name,
                 v_version, 'inferred', p_collected_at);
        ELSIF v_previous.version IS DISTINCT FROM v_version THEN
            v_updated := v_updated + 1;
            INSERT INTO software_change_events
                (organization_id, device_id, change_type, product_key, name,
                 from_version, to_version, source, detected_at)
            VALUES
                (v_device.organization_id, p_device_id, 'updated', v_key, v_name,
                 v_previous.version, v_version, 'inferred', p_collected_at);
        END IF;
    END LOOP;

    -- Remove products that are no longer present.
    FOR v_previous IN
        SELECT * FROM device_software
        WHERE device_id = p_device_id
          AND product_key NOT IN (SELECT product_key FROM rmm_scan_apps)
    LOOP
        INSERT INTO software_change_events
            (organization_id, device_id, change_type, product_key, name,
             from_version, to_version, source, detected_at)
        VALUES
            (v_device.organization_id, p_device_id, 'removed', v_previous.product_key,
             v_previous.name, v_previous.version, NULL, 'inferred', p_collected_at);

        DELETE FROM device_software WHERE id = v_previous.id;
        v_removed := v_removed + 1;
    END LOOP;

    UPDATE devices SET last_software_scan_at = now() WHERE id = p_device_id;
    RETURN jsonb_build_object(
        'added', v_added, 'updated', v_updated, 'removed', v_removed,
        'total', (SELECT COUNT(*) FROM device_software WHERE device_id = p_device_id));
END;
$$;

-- ============================================================
-- MONITOR RESULTS AND ALERT STATE MACHINE
-- ============================================================
CREATE OR REPLACE FUNCTION rmm_report_monitor_result(
    p_device_id UUID,
    p_monitor_id UUID,
    p_status monitor_status,
    p_value DOUBLE PRECISION,
    p_message TEXT,
    p_details JSONB,
    p_duration_ms INT,
    p_error TEXT,
    p_observed_at TIMESTAMPTZ DEFAULT now(),
    p_recovery_performed BOOLEAN DEFAULT FALSE,
    p_recovery_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_monitor monitors;
    v_device devices;
    v_state monitor_state;
    v_alert alerts;
    v_breaches INT;
    v_oks INT;
    v_alert_severity monitor_severity;
    v_alert_id UUID := NULL;
    v_resolved BOOLEAN := FALSE;
BEGIN
    SELECT * INTO v_device FROM devices
    WHERE id = p_device_id AND enrollment_status = 'enrolled';
    IF NOT FOUND THEN RAISE EXCEPTION 'device_not_authorized'; END IF;

    SELECT * INTO v_monitor FROM monitors
    WHERE id = p_monitor_id AND enabled;
    IF NOT FOUND THEN RAISE EXCEPTION 'monitor_not_found'; END IF;

    IF v_monitor.organization_id <> v_device.organization_id THEN
        RAISE EXCEPTION 'monitor_device_org_mismatch';
    END IF;
    -- Enforce scope server-side: a device cannot report on a monitor that does
    -- not target it, even if it knows the id.
    IF v_monitor.device_id IS NOT NULL AND v_monitor.device_id <> p_device_id THEN
        RAISE EXCEPTION 'monitor_not_in_scope';
    END IF;
    IF v_monitor.group_id IS NOT NULL
       AND NOT rmm_device_matches_group(p_device_id, v_monitor.group_id) THEN
        RAISE EXCEPTION 'monitor_not_in_scope';
    END IF;

    IF p_observed_at > now() + interval '1 hour'
       OR p_observed_at < now() - interval '7 days' THEN
        RAISE EXCEPTION 'invalid_observed_at';
    END IF;

    INSERT INTO monitor_results
        (organization_id, monitor_id, device_id, status, value, message, details,
         duration_ms, error, observed_at)
    VALUES
        (v_monitor.organization_id, p_monitor_id, p_device_id, p_status,
         CASE WHEN p_value = 'NaN'::DOUBLE PRECISION OR p_value IN ('Infinity'::DOUBLE PRECISION, '-Infinity'::DOUBLE PRECISION)
              THEN NULL ELSE p_value END,
         LEFT(p_message, 2000),
         CASE WHEN jsonb_typeof(p_details) = 'object' AND pg_column_size(p_details) <= 16384
              THEN p_details ELSE '{}'::JSONB END,
         LEAST(GREATEST(p_duration_ms, 0), 600000),
         LEFT(p_error, 2000),
         p_observed_at);

    SELECT * INTO v_state FROM monitor_state
    WHERE monitor_id = p_monitor_id AND device_id = p_device_id
    FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO monitor_state (monitor_id, device_id, last_status, last_value, last_message, last_run_at)
        VALUES (p_monitor_id, p_device_id, p_status, p_value, LEFT(p_message, 2000), p_observed_at)
        RETURNING * INTO v_state;
    END IF;

    v_breaches := v_state.consecutive_breaches;
    v_oks := v_state.consecutive_oks;

    IF p_status IN ('warning', 'critical', 'error') THEN
        v_breaches := v_breaches + 1;
        v_oks := 0;
    ELSIF p_status = 'ok' THEN
        v_oks := v_oks + 1;
        v_breaches := 0;
    END IF;
    -- 'unknown' leaves the counters unchanged: missing data must neither raise
    -- nor clear an alert.

    UPDATE monitor_state SET
        last_status = p_status,
        consecutive_breaches = v_breaches,
        consecutive_oks = v_oks,
        last_value = p_value,
        last_message = LEFT(p_message, 2000),
        last_run_at = p_observed_at,
        updated_at = now()
    WHERE monitor_id = p_monitor_id AND device_id = p_device_id;

    IF p_status IN ('warning', 'critical', 'error') AND v_breaches >= v_monitor.breach_samples THEN
        v_alert_severity := CASE
            WHEN p_status = 'critical' THEN 'critical'::monitor_severity
            ELSE v_monitor.severity
        END;

        SELECT * INTO v_alert FROM alerts
        WHERE monitor_id = p_monitor_id AND device_id = p_device_id
          AND status <> 'resolved'
        FOR UPDATE;

        IF FOUND THEN
            UPDATE alerts SET
                severity = v_alert_severity,
                summary = LEFT(COALESCE(p_message, v_monitor.name), 500),
                details = jsonb_build_object(
                    'value', p_value,
                    'status', p_status,
                    'consecutive_breaches', v_breaches,
                    'monitor_kind', v_monitor.kind,
                    'error', LEFT(p_error, 2000)),
                last_seen_at = p_observed_at
            WHERE id = v_alert.id;
            v_alert_id := v_alert.id;
        ELSE
            INSERT INTO alerts
                (organization_id, device_id, monitor_id, severity, summary, details,
                 first_seen_at, last_seen_at)
            VALUES
                (v_monitor.organization_id, p_device_id, p_monitor_id, v_alert_severity,
                 LEFT(COALESCE(p_message, v_monitor.name), 500),
                 jsonb_build_object(
                    'value', p_value,
                    'status', p_status,
                    'consecutive_breaches', v_breaches,
                    'monitor_kind', v_monitor.kind,
                    'error', LEFT(p_error, 2000)),
                 p_observed_at, p_observed_at)
            RETURNING id INTO v_alert_id;

            INSERT INTO alert_events (alert_id, event_type, actor_type, note)
            VALUES (v_alert_id, 'opened', 'device', 'Threshold breached for ' || v_breaches || ' sample(s)');
        END IF;

    ELSIF p_status = 'ok' AND v_oks >= v_monitor.recovery_samples THEN
        UPDATE alerts SET
            status = 'resolved',
            resolved_at = p_observed_at,
            last_seen_at = p_observed_at
        WHERE monitor_id = p_monitor_id AND device_id = p_device_id
          AND status <> 'resolved'
        RETURNING id INTO v_alert_id;

        IF v_alert_id IS NOT NULL THEN
            v_resolved := TRUE;
            INSERT INTO alert_events (alert_id, event_type, actor_type, note)
            VALUES (v_alert_id, 'resolved', 'device', 'Monitor recovered for '
                    || v_oks || ' sample(s)');
        END IF;
    END IF;

    IF p_recovery_performed THEN
        INSERT INTO agent_health_events (organization_id, device_id, event_type, detail)
        VALUES (v_monitor.organization_id, p_device_id, 'monitor.recovery',
                LEFT(COALESCE(p_recovery_note, 'Automated recovery action'), 2000));
        IF v_alert_id IS NOT NULL THEN
            INSERT INTO alert_events (alert_id, event_type, actor_type, note)
            VALUES (v_alert_id, 'recovery_attempted', 'device', LEFT(p_recovery_note, 2000));
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'ok', TRUE,
        'monitor_id', p_monitor_id,
        'alert_id', v_alert_id,
        'alert_resolved', v_resolved,
        'consecutive_breaches', v_breaches,
        'consecutive_oks', v_oks);
END;
$$;

-- ============================================================
-- AGENT CONFIG / WORK POLLING
-- ============================================================
CREATE OR REPLACE FUNCTION rmm_get_agent_config(p_device_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_device devices;
    v_settings organization_settings;
BEGIN
    SELECT * INTO v_device FROM devices
    WHERE id = p_device_id AND enrollment_status = 'enrolled';
    IF NOT FOUND THEN RAISE EXCEPTION 'device_not_authorized'; END IF;

    SELECT * INTO v_settings FROM organization_settings
    WHERE organization_id = v_device.organization_id;

    RETURN jsonb_build_object(
        'server_time', now(),
        'settings', jsonb_build_object(
            'metrics_interval_seconds', COALESCE(v_settings.metrics_interval_seconds, 60),
            'inventory_interval_seconds', COALESCE(v_settings.inventory_interval_seconds, 21600),
            'software_scan_interval_seconds', COALESCE(v_settings.software_scan_interval_seconds, 21600),
            'event_scan_interval_seconds', COALESCE(v_settings.event_scan_interval_seconds, 300),
            'allow_custom_powershell_monitors', COALESCE(v_settings.allow_custom_powershell_monitors, FALSE),
            'allow_security_event_collection', COALESCE(v_settings.allow_security_event_collection, FALSE),
            'allow_service_recovery', COALESCE(v_settings.allow_service_recovery, FALSE),
            'service_recovery_cooldown_seconds', COALESCE(v_settings.service_recovery_cooldown_seconds, 600),
            'max_event_bytes_per_scan', COALESCE(v_settings.max_event_bytes_per_scan, 1048576)
        ),
        'monitors', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', m.id,
                'name', m.name,
                'kind', m.kind,
                'config', m.config,
                'interval_seconds', m.interval_seconds,
                'timeout_seconds', m.timeout_seconds,
                'severity', m.severity,
                'auto_recovery', m.auto_recovery,
                'recovery_action', m.recovery_action,
                'last_run_at', ms.last_run_at
            ) ORDER BY m.name)
            FROM monitors m
            LEFT JOIN monitor_state ms
                ON ms.monitor_id = m.id AND ms.device_id = p_device_id
            WHERE m.organization_id = v_device.organization_id
              AND m.enabled
              AND (
                    m.device_id = p_device_id
                 OR (m.device_id IS NULL AND m.group_id IS NULL)
                 OR (m.group_id IS NOT NULL AND rmm_device_matches_group(p_device_id, m.group_id))
              )
        ), '[]'::JSONB)
    );
END;
$$;

-- ============================================================
-- DEPLOYMENT CLAIM / PROGRESS
-- ============================================================
CREATE OR REPLACE FUNCTION rmm_maintenance_window_open(p_window JSONB, p_at TIMESTAMPTZ DEFAULT now())
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_start TIME;
    v_end TIME;
    v_days INT[];
    v_local TIMESTAMP;
BEGIN
    IF p_window IS NULL OR p_window = '{}'::JSONB THEN
        RETURN TRUE;
    END IF;

    v_start := NULLIF(p_window ->> 'start', '')::TIME;
    v_end := NULLIF(p_window ->> 'end', '')::TIME;
    IF v_start IS NULL OR v_end IS NULL THEN
        RETURN TRUE;
    END IF;

    -- Windows are evaluated in UTC. Time zone conversion is intentionally not
    -- attempted here so behaviour is deterministic on the server.
    v_local := p_at AT TIME ZONE 'UTC';

    IF jsonb_typeof(p_window -> 'days') = 'array' THEN
        SELECT array_agg((value)::INT) INTO v_days
        FROM jsonb_array_elements_text(p_window -> 'days') AS value;
        IF v_days IS NOT NULL AND NOT (EXTRACT(ISODOW FROM v_local)::INT = ANY (v_days)) THEN
            RETURN FALSE;
        END IF;
    END IF;

    IF v_start <= v_end THEN
        RETURN v_local::TIME >= v_start AND v_local::TIME <= v_end;
    ELSE
        -- Overnight window, e.g. 22:00 â†’ 02:00.
        RETURN v_local::TIME >= v_start OR v_local::TIME <= v_end;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION rmm_deployment_targets(p_policy_id UUID)
RETURNS SETOF UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_policy deployment_policies;
BEGIN
    SELECT * INTO v_policy FROM deployment_policies WHERE id = p_policy_id;
    IF NOT FOUND THEN RETURN; END IF;

    IF v_policy.target_type = 'device' THEN
        RETURN QUERY SELECT d.id FROM devices d
        WHERE d.id = v_policy.target_device_id AND d.enrollment_status = 'enrolled';
    ELSE
        RETURN QUERY SELECT g.id FROM rmm_group_device_ids(v_policy.target_group_id) AS g;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION rmm_claim_deployment(p_device_id UUID)
RETURNS TABLE (
    job_id UUID,
    package_version_id UUID,
    operation deployment_operation,
    attempt_number INT,
    package_name TEXT,
    package_format package_format,
    version TEXT,
    storage_path TEXT,
    sha256 TEXT,
    file_size_bytes BIGINT,
    install_args TEXT,
    uninstall_args TEXT,
    repair_args TEXT,
    detection_rules JSONB,
    prerequisites JSONB,
    signature_subject TEXT,
    requires_reboot BOOLEAN,
    timeout_seconds INT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_device devices;
    v_job deployment_jobs;
    v_version software_package_versions;
    v_package software_packages;
    v_policy deployment_policies;
    v_active INT;
    v_limit INT;
BEGIN
    SELECT * INTO v_device FROM devices
    WHERE id = p_device_id AND enrollment_status = 'enrolled';
    IF NOT FOUND THEN RAISE EXCEPTION 'device_not_authorized'; END IF;

    -- A job stuck in an active phase for two hours means the agent stopped
    -- reporting (crash, power loss, uninstall). Fail it explicitly instead of
    -- leaving it in-flight forever; it is never silently re-run.
    UPDATE deployment_jobs SET
        state = 'failed',
        error_summary = 'Agent stopped reporting during execution; outcome unknown',
        completed_at = now()
    WHERE device_id = p_device_id
      AND state IN ('downloading', 'validating', 'installing', 'verifying')
      AND claimed_at < now() - interval '2 hours';

    SELECT dj.* INTO v_job
    FROM deployment_jobs dj
    LEFT JOIN deployment_policies dp ON dp.id = dj.policy_id
    WHERE dj.device_id = p_device_id
      AND dj.state IN ('pending', 'queued')
      AND COALESCE(dj.scheduled_for, now()) <= now()
      AND (dp.id IS NULL OR dp.enabled)
      AND (dp.id IS NULL OR rmm_maintenance_window_open(dp.maintenance_window))
    ORDER BY dj.created_at ASC
    LIMIT 1
    FOR UPDATE OF dj SKIP LOCKED;

    IF v_job IS NULL THEN RETURN; END IF;

    SELECT * INTO v_version FROM software_package_versions
    WHERE id = v_job.package_version_id;
    IF v_version IS NULL OR v_version.approval_status <> 'approved' THEN
        UPDATE deployment_jobs SET
            state = 'blocked',
            error_summary = 'Package version is not approved for deployment',
            completed_at = now()
        WHERE id = v_job.id;
        RETURN;
    END IF;

    SELECT * INTO v_package FROM software_packages WHERE id = v_version.package_id;
    IF v_job.policy_id IS NOT NULL THEN
        SELECT * INTO v_policy FROM deployment_policies WHERE id = v_job.policy_id;
        v_limit := LEAST(COALESCE(v_policy.concurrency_limit, 5),
                         (SELECT deployment_concurrency_limit FROM organization_settings
                           WHERE organization_id = v_device.organization_id)::INT);
    ELSE
        SELECT deployment_concurrency_limit INTO v_limit FROM organization_settings
        WHERE organization_id = v_device.organization_id;
    END IF;

    SELECT COUNT(*) INTO v_active FROM deployment_jobs
    WHERE organization_id = v_device.organization_id
      AND state IN ('downloading', 'validating', 'installing', 'verifying');

    IF v_active >= COALESCE(v_limit, 5) THEN
        RETURN; -- rollout concurrency reached; try again later
    END IF;

    UPDATE deployment_jobs SET
        state = 'downloading',
        progress = 10,
        attempts = attempts + 1,
        claimed_at = now(),
        started_at = COALESCE(started_at, now()),
        error_summary = NULL
    WHERE id = v_job.id
    RETURNING * INTO v_job;

    INSERT INTO deployment_attempts (job_id, attempt_number, state)
    VALUES (v_job.id, v_job.attempts, 'downloading')
    ON CONFLICT ON CONSTRAINT deployment_attempts_job_id_attempt_number_key DO UPDATE SET
        state = EXCLUDED.state,
        started_at = now();

    RETURN QUERY SELECT
        v_job.id,
        v_version.id,
        v_job.operation,
        v_job.attempts,
        v_package.name,
        v_version.package_format,
        v_version.version,
        v_version.storage_path,
        v_version.sha256,
        v_version.file_size_bytes,
        CASE v_job.operation
            WHEN 'uninstall' THEN COALESCE(v_version.uninstall_args, v_version.install_args)
            WHEN 'repair' THEN COALESCE(v_version.repair_args, v_version.install_args)
            ELSE v_version.install_args
        END,
        v_version.uninstall_args,
        v_version.repair_args,
        v_version.detection_rules,
        v_version.prerequisites,
        v_version.signature_subject,
        v_version.requires_reboot,
        LEAST(GREATEST(v_job.max_attempts, 1) * 600, 3600);
END;
$$;

CREATE OR REPLACE FUNCTION rmm_update_deployment(
    p_device_id UUID,
    p_job_id UUID,
    p_state deployment_state,
    p_progress INT DEFAULT NULL,
    p_exit_code INT DEFAULT NULL,
    p_output TEXT DEFAULT NULL,
    p_error TEXT DEFAULT NULL,
    p_reboot_required BOOLEAN DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_job deployment_jobs;
    v_terminal BOOLEAN;
    v_terminal_states deployment_state[] := ARRAY[
        'succeeded', 'failed', 'cancelled', 'expired', 'reboot_required', 'blocked'
    ]::deployment_state[];
BEGIN
    SELECT * INTO v_job FROM deployment_jobs
    WHERE id = p_job_id AND device_id = p_device_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'deployment_not_found'; END IF;

    -- A terminal job cannot be resurrected by a late/duplicate agent report.
    IF v_job.state = ANY (v_terminal_states) THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_terminal', 'state', v_job.state);
    END IF;

    v_terminal := p_state = ANY (v_terminal_states);

    UPDATE deployment_jobs SET
        state = p_state,
        progress = CASE
            WHEN p_state = 'succeeded' OR p_state = 'reboot_required' THEN 100
            WHEN p_progress IS NOT NULL THEN LEAST(GREATEST(p_progress, 0), 100)
            ELSE progress
        END,
        exit_code = COALESCE(p_exit_code, exit_code),
        stdout_text = CASE WHEN p_output IS NULL THEN stdout_text
                           ELSE LEFT(p_output, 65536) END,
        error_summary = COALESCE(LEFT(p_error, 2000), error_summary),
        reboot_required = COALESCE(p_reboot_required, reboot_required),
        completed_at = CASE WHEN v_terminal THEN now() ELSE completed_at END
    WHERE id = p_job_id;

    UPDATE deployment_attempts SET
        state = p_state,
        exit_code = COALESCE(p_exit_code, exit_code),
        output = CASE WHEN p_output IS NULL THEN output ELSE LEFT(p_output, 32768) END,
        error_summary = COALESCE(LEFT(p_error, 2000), error_summary),
        completed_at = CASE WHEN v_terminal THEN now() ELSE completed_at END
    WHERE job_id = p_job_id AND attempt_number = v_job.attempts;

    -- Confirmed software changes from a succeeded management job.
    IF p_state IN ('succeeded', 'reboot_required') AND v_job.operation IN ('install', 'update', 'repair', 'uninstall', 'rollback') THEN
        INSERT INTO software_change_events
            (organization_id, device_id, change_type, product_key, name,
             from_version, to_version, source, deployment_job_id, actor_user_id)
        SELECT
            v_job.organization_id,
            v_job.device_id,
            CASE WHEN v_job.operation = 'uninstall' THEN 'removed'::software_change_type
                 WHEN v_job.operation = 'update' THEN 'updated'::software_change_type
                 ELSE 'installed'::software_change_type END,
            LEFT(sp.name || '|' || COALESCE(sp.publisher, '') || '|' || spv.architecture, 400),
            sp.name,
            NULL,
            spv.version,
            'confirmed',
            v_job.id,
            v_job.requested_by
        FROM software_package_versions spv
        JOIN software_packages sp ON sp.id = spv.package_id
        WHERE spv.id = v_job.package_version_id;
    END IF;

    RETURN jsonb_build_object('ok', TRUE, 'state', p_state);
END;
$$;

-- ============================================================
-- HEARTBEAT FAILURE / OFFLINE MAINTENANCE
-- ============================================================
CREATE OR REPLACE FUNCTION rmm_mark_stale_devices(p_stale_seconds INT DEFAULT NULL)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INT := 0;
    v_row RECORD;
BEGIN
    FOR v_row IN
        SELECT d.id, d.organization_id, d.last_heartbeat_at,
               COALESCE(s.offline_after_seconds, 300) AS threshold
        FROM devices d
        LEFT JOIN organization_settings s ON s.organization_id = d.organization_id
        WHERE d.enrollment_status = 'enrolled'
          AND d.service_status IS DISTINCT FROM 'offline'
          AND d.last_heartbeat_at IS NOT NULL
    LOOP
        IF v_row.last_heartbeat_at < now() - make_interval(secs => COALESCE(p_stale_seconds, v_row.threshold)) THEN
            UPDATE devices SET service_status = 'offline' WHERE id = v_row.id;
            INSERT INTO agent_health_events (organization_id, device_id, event_type, detail)
            VALUES (v_row.organization_id, v_row.id, 'agent.offline',
                    'No heartbeat for ' || EXTRACT(EPOCH FROM (now() - v_row.last_heartbeat_at))::INT || ' seconds');
            v_count := v_count + 1;
        END IF;
    END LOOP;
    RETURN v_count;
END;
$$;

-- ============================================================
-- HEALTH SCORE
-- ============================================================
CREATE OR REPLACE FUNCTION device_health_score(p_device_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_device devices;
    v_inv device_inventory;
    v_settings organization_settings;
    v_open_critical INT := 0;
    v_open_warning INT := 0;
    v_failed_monitors INT := 0;
    v_total_monitors INT := 0;
    v_low_disk BOOLEAN := FALSE;
    v_pending_reboot BOOLEAN := FALSE;
    v_heartbeat_age INT;
    v_offline_after INT := 300;
    v_earned NUMERIC := 0;
    v_known NUMERIC := 0;
    v_total NUMERIC := 0;
    v_factors JSONB := '[]'::JSONB;
    v_score NUMERIC;
    v_confidence NUMERIC;
BEGIN
    SELECT * INTO v_device FROM devices WHERE id = p_device_id;
    IF NOT FOUND THEN RETURN NULL; END IF;

    SELECT * INTO v_settings FROM organization_settings
    WHERE organization_id = v_device.organization_id;
    v_offline_after := COALESCE(v_settings.offline_after_seconds, 300);

    SELECT * INTO v_inv FROM device_inventory WHERE device_id = p_device_id;

    SELECT COUNT(*) FILTER (WHERE severity = 'critical'),
           COUNT(*) FILTER (WHERE severity = 'warning')
    INTO v_open_critical, v_open_warning
    FROM alerts
    WHERE device_id = p_device_id AND status <> 'resolved';

    SELECT COUNT(*) FILTER (WHERE ms.last_status IN ('warning', 'critical')),
           COUNT(*)
    INTO v_failed_monitors, v_total_monitors
    FROM monitor_state ms
    JOIN monitors m ON m.id = ms.monitor_id
    WHERE ms.device_id = p_device_id AND m.enabled;

    IF v_inv IS NOT NULL AND jsonb_typeof(v_inv.os -> 'disks') = 'array' THEN
        SELECT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_inv.os -> 'disks') d
            WHERE COALESCE((d ->> 'used_percent')::NUMERIC, 0) >= 90
        ) INTO v_low_disk;
    END IF;

    v_pending_reboot := COALESCE((v_inv.os ->> 'pending_reboot')::BOOLEAN, FALSE);

    v_heartbeat_age := CASE WHEN v_device.last_heartbeat_at IS NULL THEN NULL
        ELSE EXTRACT(EPOCH FROM (now() - v_device.last_heartbeat_at))::INT END;

    -- Agent health (weight 30)
    v_total := v_total + 30;
    IF v_device.enrollment_status IN ('suspended', 'revoked') THEN
        v_factors := v_factors || jsonb_build_object('key', 'agent', 'label', 'Agent health',
            'status', 'critical', 'weight', 30, 'earned', 0,
            'detail', 'Device is ' || v_device.enrollment_status);
    ELSIF v_heartbeat_age IS NULL THEN
        v_factors := v_factors || jsonb_build_object('key', 'agent', 'label', 'Agent health',
            'status', 'unknown', 'weight', 30, 'earned', 0,
            'detail', 'No heartbeat recorded');
    ELSIF v_heartbeat_age > v_offline_after THEN
        v_factors := v_factors || jsonb_build_object('key', 'agent', 'label', 'Agent health',
            'status', 'critical', 'weight', 30, 'earned', 0,
            'detail', 'Last heartbeat ' || v_heartbeat_age || 's ago');
        v_known := v_known + 30;
    ELSE
        v_factors := v_factors || jsonb_build_object('key', 'agent', 'label', 'Agent health',
            'status', 'ok', 'weight', 30, 'earned', 30,
            'detail', 'Heartbeat ' || v_heartbeat_age || 's ago');
        v_earned := v_earned + 30;
        v_known := v_known + 30;
    END IF;

    -- Active alerts (weight 30)
    v_total := v_total + 30;
    IF v_open_critical > 0 THEN
        v_factors := v_factors || jsonb_build_object('key', 'alerts', 'label', 'Active alerts',
            'status', 'critical', 'weight', 30, 'earned', 0,
            'detail', v_open_critical || ' critical, ' || v_open_warning || ' warning');
        v_known := v_known + 30;
    ELSIF v_open_warning > 0 THEN
        v_factors := v_factors || jsonb_build_object('key', 'alerts', 'label', 'Active alerts',
            'status', 'warning', 'weight', 30, 'earned', 15,
            'detail', v_open_warning || ' warning alert(s)');
        v_earned := v_earned + 15;
        v_known := v_known + 30;
    ELSE
        v_factors := v_factors || jsonb_build_object('key', 'alerts', 'label', 'Active alerts',
            'status', 'ok', 'weight', 30, 'earned', 30, 'detail', 'No open alerts');
        v_earned := v_earned + 30;
        v_known := v_known + 30;
    END IF;

    -- Monitor results (weight 20)
    v_total := v_total + 20;
    IF v_total_monitors = 0 THEN
        v_factors := v_factors || jsonb_build_object('key', 'monitors', 'label', 'Monitors',
            'status', 'unknown', 'weight', 20, 'earned', 0,
            'detail', 'No monitor results reported');
    ELSE
        v_known := v_known + 20;
        IF v_failed_monitors > 0 THEN
            v_factors := v_factors || jsonb_build_object('key', 'monitors', 'label', 'Monitors',
                'status', 'warning', 'weight', 20, 'earned', 0,
                'detail', v_failed_monitors || ' of ' || v_total_monitors || ' monitors failing');
        ELSE
            v_factors := v_factors || jsonb_build_object('key', 'monitors', 'label', 'Monitors',
                'status', 'ok', 'weight', 20, 'earned', 20,
                'detail', v_total_monitors || ' monitor(s) healthy');
            v_earned := v_earned + 20;
        END IF;
    END IF;

    -- Disk pressure (weight 10)
    v_total := v_total + 10;
    IF v_inv IS NULL THEN
        v_factors := v_factors || jsonb_build_object('key', 'storage', 'label', 'Storage',
            'status', 'unknown', 'weight', 10, 'earned', 0,
            'detail', 'No inventory collected');
    ELSE
        v_known := v_known + 10;
        IF v_low_disk THEN
            v_factors := v_factors || jsonb_build_object('key', 'storage', 'label', 'Storage',
                'status', 'warning', 'weight', 10, 'earned', 0,
                'detail', 'A volume is at or above 90% used');
        ELSE
            v_factors := v_factors || jsonb_build_object('key', 'storage', 'label', 'Storage',
                'status', 'ok', 'weight', 10, 'earned', 10, 'detail', 'No volume above 90% used');
            v_earned := v_earned + 10;
        END IF;
    END IF;

    -- Patch / reboot state (weight 10)
    v_total := v_total + 10;
    IF v_inv IS NULL OR v_inv.os ->> 'pending_reboot' IS NULL THEN
        v_factors := v_factors || jsonb_build_object('key', 'patching', 'label', 'Patch state',
            'status', 'unknown', 'weight', 10, 'earned', 0,
            'detail', 'Patch/reboot state not reported');
    ELSE
        v_known := v_known + 10;
        IF v_pending_reboot THEN
            v_factors := v_factors || jsonb_build_object('key', 'patching', 'label', 'Patch state',
                'status', 'warning', 'weight', 10, 'earned', 0,
                'detail', 'A reboot is pending');
        ELSE
            v_factors := v_factors || jsonb_build_object('key', 'patching', 'label', 'Patch state',
                'status', 'ok', 'weight', 10, 'earned', 10,
                'detail', 'No pending reboot');
            v_earned := v_earned + 10;
        END IF;
    END IF;

    -- A score is only meaningful when the agent has checked in. Otherwise an
    -- offline endpoint with no telemetry would appear healthy on the strength
    -- of "no alerts", which is exactly the failure mode this score must avoid.
    IF v_known > 0 AND v_heartbeat_age IS NOT NULL
       AND v_device.enrollment_status = 'enrolled' THEN
        v_score := ROUND(100 * v_earned / v_known);
    ELSE
        v_score := NULL;
    END IF;
    v_confidence := ROUND(100 * v_known / v_total);

    RETURN jsonb_build_object(
        'score', v_score,
        'confidence', v_confidence,
        'known_weight', v_known,
        'total_weight', v_total,
        'factors', v_factors,
        'calculated_at', now()
    );
END;
$$;

-- ============================================================
-- RETENTION
-- ============================================================
CREATE OR REPLACE FUNCTION rmm_apply_retention(p_organization_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_metrics INT := 0;
    v_results INT := 0;
    v_events INT := 0;
    v_inv_snapshots INT := 0;
    v_deploy_output INT := 0;
    v_settings organization_settings;
BEGIN
    FOR v_settings IN
        SELECT * FROM organization_settings
        WHERE p_organization_id IS NULL OR organization_id = p_organization_id
    LOOP
        DELETE FROM device_metrics
        WHERE organization_id = v_settings.organization_id
          AND collected_at < now() - make_interval(days => v_settings.metrics_retention_days);
        GET DIAGNOSTICS v_metrics = ROW_COUNT;

        DELETE FROM monitor_results
        WHERE organization_id = v_settings.organization_id
          AND observed_at < now() - make_interval(days => v_settings.monitor_results_retention_days);

        DELETE FROM device_events
        WHERE organization_id = v_settings.organization_id
          AND received_at < now() - make_interval(days => v_settings.event_retention_days);

        DELETE FROM device_inventory_snapshots
        WHERE organization_id = v_settings.organization_id
          AND created_at < now() - interval '365 days';

        UPDATE deployment_jobs SET
            stdout_text = NULL,
            stderr_text = NULL
        WHERE organization_id = v_settings.organization_id
          AND completed_at IS NOT NULL
          AND completed_at < now() - make_interval(days => v_settings.deployment_output_retention_days)
          AND (stdout_text IS NOT NULL OR stderr_text IS NOT NULL);
        GET DIAGNOSTICS v_deploy_output = ROW_COUNT;

        UPDATE deployment_attempts da SET output = NULL
        FROM deployment_jobs dj
        WHERE da.job_id = dj.id
          AND dj.organization_id = v_settings.organization_id
          AND dj.completed_at IS NOT NULL
          AND dj.completed_at < now() - make_interval(days => v_settings.deployment_output_retention_days)
          AND da.output IS NOT NULL;
    END LOOP;

    RETURN jsonb_build_object(
        'metrics_deleted', v_metrics,
        'monitor_results_deleted', v_results,
        'events_deleted', v_events,
        'deployment_output_cleared', v_deploy_output);
END;
$$;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE device_groups               ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_group_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_inventory            ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_inventory_snapshots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_metrics              ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitors                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitor_state               ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitor_results             ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_events                ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_events               ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_health_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_software             ENABLE ROW LEVEL SECURITY;
ALTER TABLE software_change_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE software_packages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE software_package_versions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_policies         ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_jobs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_attempts         ENABLE ROW LEVEL SECURITY;

-- Helper: the organisation of a device group.
CREATE OR REPLACE FUNCTION auth_group_org(p_group_id UUID)
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT organization_id FROM device_groups WHERE id = p_group_id;
$$;

-- Read policies for organisation members.
CREATE POLICY groups_select ON device_groups FOR SELECT TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'auditor'));
CREATE POLICY groups_write ON device_groups FOR ALL TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'administrator'))
    WITH CHECK (NOT auth_is_device() AND auth_has_role(organization_id, 'administrator'));

CREATE POLICY group_members_select ON device_group_members FOR SELECT TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(auth_group_org(group_id), 'auditor'));
CREATE POLICY group_members_write ON device_group_members FOR ALL TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(auth_group_org(group_id), 'administrator'))
    WITH CHECK (NOT auth_is_device() AND auth_has_role(auth_group_org(group_id), 'administrator'));

CREATE POLICY inventory_select ON device_inventory FOR SELECT TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'auditor'));
CREATE POLICY inventory_snapshots_select ON device_inventory_snapshots FOR SELECT TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'auditor'));
CREATE POLICY metrics_select ON device_metrics FOR SELECT TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'auditor'));

CREATE POLICY monitors_select ON monitors FOR SELECT TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'auditor'));
CREATE POLICY monitors_write ON monitors FOR ALL TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'administrator'))
    WITH CHECK (NOT auth_is_device() AND auth_has_role(organization_id, 'administrator'));

CREATE POLICY monitor_state_select ON monitor_state FOR SELECT TO authenticated
    USING (NOT auth_is_device() AND EXISTS (
        SELECT 1 FROM monitors m WHERE m.id = monitor_id
          AND auth_has_role(m.organization_id, 'auditor')));
CREATE POLICY monitor_results_select ON monitor_results FOR SELECT TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'auditor'));

CREATE POLICY alerts_select ON alerts FOR SELECT TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'auditor'));
CREATE POLICY alerts_update ON alerts FOR UPDATE TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'administrator'))
    WITH CHECK (NOT auth_is_device() AND auth_has_role(organization_id, 'administrator'));

CREATE POLICY alert_events_select ON alert_events FOR SELECT TO authenticated
    USING (NOT auth_is_device() AND EXISTS (
        SELECT 1 FROM alerts a WHERE a.id = alert_id
          AND auth_has_role(a.organization_id, 'auditor')));

CREATE POLICY device_events_select ON device_events FOR SELECT TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'auditor'));
CREATE POLICY agent_health_select ON agent_health_events FOR SELECT TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'auditor'));

CREATE POLICY software_select ON device_software FOR SELECT TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'auditor'));
CREATE POLICY software_changes_select ON software_change_events FOR SELECT TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'auditor'));

CREATE POLICY packages_select ON software_packages FOR SELECT TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'auditor'));
CREATE POLICY packages_write ON software_packages FOR ALL TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'administrator'))
    WITH CHECK (NOT auth_is_device() AND auth_has_role(organization_id, 'administrator'));

CREATE POLICY package_versions_select ON software_package_versions FOR SELECT TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'auditor'));
CREATE POLICY package_versions_write ON software_package_versions FOR ALL TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'administrator'))
    WITH CHECK (NOT auth_is_device() AND auth_has_role(organization_id, 'administrator'));

CREATE POLICY deployment_policies_select ON deployment_policies FOR SELECT TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'auditor'));
CREATE POLICY deployment_policies_write ON deployment_policies FOR ALL TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'administrator'))
    WITH CHECK (NOT auth_is_device() AND auth_has_role(organization_id, 'administrator'));

CREATE POLICY deployment_jobs_select ON deployment_jobs FOR SELECT TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'auditor'));
CREATE POLICY deployment_jobs_write ON deployment_jobs FOR ALL TO authenticated
    USING (NOT auth_is_device() AND auth_has_role(organization_id, 'operator'))
    WITH CHECK (NOT auth_is_device() AND auth_has_role(organization_id, 'operator'));

CREATE POLICY deployment_attempts_select ON deployment_attempts FOR SELECT TO authenticated
    USING (NOT auth_is_device() AND EXISTS (
        SELECT 1 FROM deployment_jobs dj WHERE dj.id = job_id
          AND auth_has_role(dj.organization_id, 'auditor')));

-- ============================================================
-- ADMIN OPERATIONS (called from dashboard APIs with service role)
-- ============================================================
CREATE OR REPLACE FUNCTION rmm_acknowledge_alert(
    p_alert_id UUID,
    p_actor_user_id UUID,
    p_org_id UUID,
    p_note TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM organization_members
        WHERE organization_id = p_org_id AND user_id = p_actor_user_id
          AND role IN ('owner', 'administrator', 'operator')
    ) THEN
        RAISE EXCEPTION 'forbidden';
    END IF;

    UPDATE alerts SET
        status = 'acknowledged',
        acknowledged_at = now(),
        acknowledged_by = p_actor_user_id
    WHERE id = p_alert_id AND organization_id = p_org_id AND status = 'open';

    IF NOT FOUND THEN RETURN FALSE; END IF;

    INSERT INTO alert_events (alert_id, event_type, actor_type, actor_id, note)
    VALUES (p_alert_id, 'acknowledged', 'user', p_actor_user_id, LEFT(p_note, 2000));

    INSERT INTO audit_events (organization_id, actor_type, actor_id, action, target_type, target_id, metadata)
    VALUES (p_org_id, 'user', p_actor_user_id, 'alert.acknowledged', 'alert', p_alert_id,
            jsonb_build_object('note', LEFT(p_note, 500)));
    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION rmm_resolve_alert(
    p_alert_id UUID,
    p_actor_user_id UUID,
    p_org_id UUID,
    p_note TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM organization_members
        WHERE organization_id = p_org_id AND user_id = p_actor_user_id
          AND role IN ('owner', 'administrator', 'operator')
    ) THEN
        RAISE EXCEPTION 'forbidden';
    END IF;

    UPDATE alerts SET
        status = 'resolved',
        resolved_at = now(),
        resolved_by = p_actor_user_id
    WHERE id = p_alert_id AND organization_id = p_org_id AND status <> 'resolved';

    IF NOT FOUND THEN RETURN FALSE; END IF;

    INSERT INTO alert_events (alert_id, event_type, actor_type, actor_id, note)
    VALUES (p_alert_id, 'resolved', 'user', p_actor_user_id, LEFT(p_note, 2000));

    INSERT INTO audit_events (organization_id, actor_type, actor_id, action, target_type, target_id, metadata)
    VALUES (p_org_id, 'user', p_actor_user_id, 'alert.resolved', 'alert', p_alert_id,
            jsonb_build_object('note', LEFT(p_note, 500)));
    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION rmm_cancel_deployment(
    p_job_id UUID,
    p_actor_user_id UUID,
    p_org_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_state deployment_state;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM organization_members
        WHERE organization_id = p_org_id AND user_id = p_actor_user_id
          AND role IN ('owner', 'administrator', 'operator')
    ) THEN
        RETURN 'forbidden';
    END IF;

    SELECT state INTO v_state FROM deployment_jobs
    WHERE id = p_job_id AND organization_id = p_org_id FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;

    IF v_state IN ('succeeded', 'failed', 'cancelled', 'expired', 'reboot_required', 'blocked') THEN
        RETURN 'already_terminal';
    END IF;

    UPDATE deployment_jobs SET
        state = 'cancelled',
        completed_at = now(),
        error_summary = 'Cancelled by administrator'
    WHERE id = p_job_id;

    UPDATE deployment_attempts SET
        state = 'cancelled',
        completed_at = now(),
        error_summary = 'Cancelled by administrator'
    WHERE job_id = p_job_id AND completed_at IS NULL;

    INSERT INTO audit_events (organization_id, actor_type, actor_id, action, target_type, target_id)
    VALUES (p_org_id, 'user', p_actor_user_id, 'deployment.cancelled', 'deployment_job', p_job_id);

    RETURN 'ok';
END;
$$;

CREATE OR REPLACE FUNCTION rmm_retry_deployment(
    p_job_id UUID,
    p_actor_user_id UUID,
    p_org_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_job deployment_jobs;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM organization_members
        WHERE organization_id = p_org_id AND user_id = p_actor_user_id
          AND role IN ('owner', 'administrator', 'operator')
    ) THEN
        RETURN 'forbidden';
    END IF;

    SELECT * INTO v_job FROM deployment_jobs
    WHERE id = p_job_id AND organization_id = p_org_id FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;

    IF v_job.state <> 'failed' THEN RETURN 'not_retryable'; END IF;
    IF v_job.attempts >= v_job.max_attempts THEN RETURN 'attempts_exhausted'; END IF;

    UPDATE deployment_jobs SET
        state = 'queued',
        progress = 0,
        error_summary = NULL,
        exit_code = NULL,
        stdout_text = NULL,
        stderr_text = NULL,
        completed_at = NULL,
        claimed_at = NULL,
        scheduled_for = now()
    WHERE id = p_job_id;

    INSERT INTO audit_events (organization_id, actor_type, actor_id, action, target_type, target_id)
    VALUES (p_org_id, 'user', p_actor_user_id, 'deployment.retried', 'deployment_job', p_job_id);

    RETURN 'ok';
END;
$$;

-- Permissions
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO authenticated, service_role;





