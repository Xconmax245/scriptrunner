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
    -- Max seconds the script process may run (1 – 86400)
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
    -- max script size in bytes (1 KB – 128 KB)
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
