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
