-- Migration: 001_initial_schema.sql
-- Description: Core schema for ScriptRunner platform
-- Phase: 1 – Organizations, members, devices, invitations

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
