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
-- that have no corresponding completed attempt — agent must resolve
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
