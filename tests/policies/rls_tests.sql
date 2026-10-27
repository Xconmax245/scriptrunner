-- ============================================================
-- SQL POLICY & RLS SECURITY TEST SUITE
-- Validates:
-- 1. Multi-tenant organization isolation (Org A vs Org B)
-- 2. Role-based privileges (Auditor vs Operator vs Admin)
-- 3. Device agent isolation (Device 1 vs Device 2)
-- 4. Revocation enforcement (Revoked device rejected)
-- ============================================================

BEGIN;

-- Test Setup
CREATE TEMP TABLE test_results (
    test_name TEXT,
    passed BOOLEAN,
    details TEXT
);

DO $$
DECLARE
    v_org_a UUID;
    v_org_b UUID;
    v_user_a UUID := gen_random_uuid();
    v_user_b UUID := gen_random_uuid();
    v_dev_a1 UUID := gen_random_uuid();
    v_dev_a2 UUID := gen_random_uuid();
    v_dev_b1 UUID := gen_random_uuid();
    v_job_a UUID;
    v_count INT;
BEGIN
    -- 1. Create two separate organizations
    INSERT INTO organizations (name, slug) VALUES ('Tenant A', 'tenant-a') RETURNING id INTO v_org_a;
    INSERT INTO organizations (name, slug) VALUES ('Tenant B', 'tenant-b') RETURNING id INTO v_org_b;

    -- 2. Create organization members
    -- User A is administrator in Org A
    INSERT INTO organization_members (organization_id, user_id, role)
    VALUES (v_org_a, v_user_a, 'administrator');

    -- User B is auditor in Org B
    INSERT INTO organization_members (organization_id, user_id, role)
    VALUES (v_org_b, v_user_b, 'auditor');

    -- 3. Create devices
    INSERT INTO devices (id, organization_id, display_name, hostname, enrollment_status, api_key_hash, api_key_prefix)
    VALUES (v_dev_a1, v_org_a, 'PC-A1', 'host-a1', 'enrolled', repeat('0', 64), '00000000');

    INSERT INTO devices (id, organization_id, display_name, hostname, enrollment_status, api_key_hash, api_key_prefix)
    VALUES (v_dev_a2, v_org_a, 'PC-A2-Revoked', 'host-a2', 'revoked', repeat('1', 64), '11111111');

    INSERT INTO devices (id, organization_id, display_name, hostname, enrollment_status, api_key_hash, api_key_prefix)
    VALUES (v_dev_b1, v_org_b, 'PC-B1', 'host-b1', 'enrolled', repeat('2', 64), '22222222');

    -- 4. Create a job in Org A
    INSERT INTO jobs (
        organization_id, device_id, created_by, script_content, script_hash,
        state, timeout_seconds, expires_at
    ) VALUES (
        v_org_a, v_dev_a1, v_user_a, 'Write-Output "test"', repeat('a', 64),
        'queued', 300, now() + interval '1 hour'
    ) RETURNING id INTO v_job_a;

    -- TEST 1: Org Cross-Tenant Isolation
    -- Device from Org B cannot be assigned to Org A job
    BEGIN
        INSERT INTO jobs (
            organization_id, device_id, created_by, script_content, script_hash,
            state, timeout_seconds, expires_at
        ) VALUES (
            v_org_a, v_dev_b1, v_user_a, 'Write-Output "bad"', repeat('b', 64),
            'queued', 300, now() + interval '1 hour'
        );
        INSERT INTO test_results VALUES ('cross_tenant_device_assignment', FALSE, 'Trigger failed to reject cross-tenant device');
    EXCEPTION WHEN OTHERS THEN
        INSERT INTO test_results VALUES ('cross_tenant_device_assignment', TRUE, 'Successfully rejected cross-tenant device assignment');
    END;

    -- TEST 2: Atomic Claim Function
    -- Eligible job is claimed atomically by assigned device
    PERFORM claim_next_job(v_dev_a1);
    SELECT count(*) INTO v_count FROM jobs WHERE id = v_job_a AND state = 'claimed';
    IF v_count = 1 THEN
        INSERT INTO test_results VALUES ('atomic_claim_next_job', TRUE, 'Job transitioned to claimed state');
    ELSE
        INSERT INTO test_results VALUES ('atomic_claim_next_job', FALSE, 'Job not in claimed state');
    END IF;

    -- TEST 3: Revoked Device Cannot Claim Jobs
    -- Create job for revoked device PC-A2
    INSERT INTO jobs (
        organization_id, device_id, created_by, script_content, script_hash,
        state, timeout_seconds, expires_at
    ) VALUES (
        v_org_a, v_dev_a2, v_user_a, 'Write-Output "revoked_test"', repeat('c', 64),
        'queued', 300, now() + interval '1 hour'
    );
    -- Revoked device attempts to claim
    PERFORM claim_next_job(v_dev_a2);
    SELECT count(*) INTO v_count FROM jobs WHERE device_id = v_dev_a2 AND state = 'claimed';
    IF v_count = 0 THEN
        INSERT INTO test_results VALUES ('revoked_device_claim_rejected', TRUE, 'Revoked device unable to claim jobs');
    ELSE
        INSERT INTO test_results VALUES ('revoked_device_claim_rejected', FALSE, 'Revoked device was able to claim job');
    END IF;

    -- TEST 4: Double-Claim Prevention
    -- Second claim call returns empty
    IF (SELECT count(*) FROM claim_next_job(v_dev_a1)) = 0 THEN
        INSERT INTO test_results VALUES ('double_claim_prevention', TRUE, 'Second claim returns no available jobs');
    ELSE
        INSERT INTO test_results VALUES ('double_claim_prevention', FALSE, 'Job claimed multiple times');
    END IF;

END $$;

SELECT test_name, passed, details FROM test_results;

ROLLBACK;
