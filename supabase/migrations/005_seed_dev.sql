-- Migration: 005_seed_dev.sql
-- Description: Development seed data (local Supabase only – never run in production)
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
