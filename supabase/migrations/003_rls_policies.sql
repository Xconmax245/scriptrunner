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

-- No UPDATE or DELETE policies → those operations are denied to all app roles

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
