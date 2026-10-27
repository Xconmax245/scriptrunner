// Auto-generated TypeScript types matching the Supabase schema.
// Run `supabase gen types typescript --local > src/types/database.ts` to regenerate.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type MemberRole = "owner" | "administrator" | "operator" | "auditor";
export type EnrollmentStatus =
  | "pending"
  | "unauthorized"
  | "enrolled"
  | "suspended"
  | "revoked";
export type JobState =
  | "queued"
  | "waiting_for_device"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "expired"
  | "outcome_unknown";
export type ScriptType = "powershell";
export type AttemptOutcome =
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "outcome_unknown";
export type ActorType = "user" | "device" | "system";

export interface Database {
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string;
          name: string;
          slug: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          name?: string;
          slug?: string;
          updated_at?: string;
        };
      };
      organization_members: {
        Row: {
          id: string;
          organization_id: string;
          user_id: string;
          role: MemberRole;
          invited_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          user_id: string;
          role?: MemberRole;
          invited_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          role?: MemberRole;
          updated_at?: string;
        };
      };
      devices: {
        Row: {
          id: string;
          organization_id: string;
          display_name: string;
          hostname: string | null;
          operating_system: string | null;
          agent_version: string | null;
          enrollment_status: EnrollmentStatus;
          last_seen_at: string | null;
          created_at: string;
          updated_at: string;
          revoked_at: string | null;
          metadata: Json;
          api_key_hash: string;
          api_key_prefix: string;
          enrolled_by: string | null;
          enrolled_at: string | null;
        };
        Insert: {
          id?: string;
          organization_id: string;
          display_name: string;
          hostname?: string | null;
          operating_system?: string | null;
          agent_version?: string | null;
          enrollment_status?: EnrollmentStatus;
          last_seen_at?: string | null;
          created_at?: string;
          updated_at?: string;
          revoked_at?: string | null;
          metadata?: Json;
          api_key_hash: string;
          api_key_prefix: string;
          enrolled_by?: string | null;
          enrolled_at?: string | null;
        };
        Update: {
          display_name?: string;
          hostname?: string | null;
          operating_system?: string | null;
          agent_version?: string | null;
          enrollment_status?: EnrollmentStatus;
          last_seen_at?: string | null;
          updated_at?: string;
          revoked_at?: string | null;
          metadata?: Json;
        };
      };
      enrollment_invitations: {
        Row: {
          id: string;
          organization_id: string;
          created_by: string;
          token_hash: string;
          token_prefix: string;
          display_name: string;
          expires_at: string;
          redeemed_at: string | null;
          redeemed_by_device: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          created_by: string;
          token_hash: string;
          token_prefix: string;
          display_name: string;
          expires_at: string;
          redeemed_at?: string | null;
          redeemed_by_device?: string | null;
          created_at?: string;
        };
        Update: {
          redeemed_at?: string | null;
          redeemed_by_device?: string | null;
        };
      };
      jobs: {
        Row: {
          id: string;
          organization_id: string;
          device_id: string;
          created_by: string;
          script_content: string;
          script_type: ScriptType;
          script_hash: string;
          description: string | null;
          change_ticket: string | null;
          state: JobState;
          created_at: string;
          not_before: string | null;
          expires_at: string;
          claimed_at: string | null;
          claimed_by_device: string | null;
          started_at: string | null;
          completed_at: string | null;
          timeout_seconds: number;
          idempotency_key: string | null;
          error_summary: string | null;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          device_id: string;
          created_by: string;
          script_content: string;
          script_type?: ScriptType;
          script_hash: string;
          description?: string | null;
          change_ticket?: string | null;
          state?: JobState;
          created_at?: string;
          not_before?: string | null;
          expires_at: string;
          claimed_at?: string | null;
          claimed_by_device?: string | null;
          started_at?: string | null;
          completed_at?: string | null;
          timeout_seconds?: number;
          idempotency_key?: string | null;
          error_summary?: string | null;
          updated_at?: string;
        };
        Update: {
          state?: JobState;
          claimed_at?: string | null;
          claimed_by_device?: string | null;
          started_at?: string | null;
          completed_at?: string | null;
          error_summary?: string | null;
          updated_at?: string;
        };
      };
      job_attempts: {
        Row: {
          id: string;
          job_id: string;
          device_id: string;
          attempt_number: number;
          state: JobState;
          agent_execution_id: string | null;
          started_at: string | null;
          completed_at: string | null;
          exit_code: number | null;
          stdout_text: string | null;
          stdout_truncated: boolean;
          stderr_text: string | null;
          stderr_truncated: boolean;
          outcome: AttemptOutcome | null;
          error_summary: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          job_id: string;
          device_id: string;
          attempt_number: number;
          state?: JobState;
          agent_execution_id?: string | null;
          started_at?: string | null;
          completed_at?: string | null;
          exit_code?: number | null;
          stdout_text?: string | null;
          stdout_truncated?: boolean;
          stderr_text?: string | null;
          stderr_truncated?: boolean;
          outcome?: AttemptOutcome | null;
          error_summary?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          state?: JobState;
          started_at?: string | null;
          completed_at?: string | null;
          exit_code?: number | null;
          stdout_text?: string | null;
          stdout_truncated?: boolean;
          stderr_text?: string | null;
          stderr_truncated?: boolean;
          outcome?: AttemptOutcome | null;
          error_summary?: string | null;
          updated_at?: string;
        };
      };
      audit_events: {
        Row: {
          id: string;
          organization_id: string | null;
          actor_type: ActorType;
          actor_id: string | null;
          action: string;
          target_type: string | null;
          target_id: string | null;
          metadata: Json;
          timestamp: string;
          ip_address: string | null;
        };
        Insert: {
          id?: string;
          organization_id?: string | null;
          actor_type: ActorType;
          actor_id?: string | null;
          action: string;
          target_type?: string | null;
          target_id?: string | null;
          metadata?: Json;
          timestamp?: string;
          ip_address?: string | null;
        };
        Update: never; // audit events are immutable
      };
      organization_settings: {
        Row: {
          organization_id: string;
          max_script_bytes: number;
          default_timeout_secs: number;
          default_expiry_secs: number;
          max_stdout_bytes: number;
          operators_can_submit: boolean;
          audit_retention_days: number;
          output_retention_days: number;
          updated_at: string;
        };
        Insert: {
          organization_id: string;
          max_script_bytes?: number;
          default_timeout_secs?: number;
          default_expiry_secs?: number;
          max_stdout_bytes?: number;
          operators_can_submit?: boolean;
          audit_retention_days?: number;
          output_retention_days?: number;
          updated_at?: string;
        };
        Update: {
          max_script_bytes?: number;
          default_timeout_secs?: number;
          default_expiry_secs?: number;
          max_stdout_bytes?: number;
          operators_can_submit?: boolean;
          audit_retention_days?: number;
          output_retention_days?: number;
          updated_at?: string;
        };
      };
    };
    Functions: {
      claim_next_job: {
        Args: { p_device_id: string };
        Returns: Database["public"]["Tables"]["jobs"]["Row"][];
      };
      mark_job_running: {
        Args: { p_job_id: string; p_device_id: string; p_attempt_id: string };
        Returns: boolean;
      };
      complete_job: {
        Args: {
          p_job_id: string;
          p_device_id: string;
          p_attempt_id: string;
          p_outcome: AttemptOutcome;
          p_exit_code: number;
          p_stdout_text: string;
          p_stdout_truncated: boolean;
          p_stderr_text: string;
          p_stderr_truncated: boolean;
          p_error_summary?: string | null;
        };
        Returns: boolean;
      };
      cancel_job: {
        Args: {
          p_job_id: string;
          p_actor_user_id: string;
          p_org_id: string;
        };
        Returns: string;
      };
      device_heartbeat: {
        Args: { p_device_id: string; p_agent_version: string };
        Returns: boolean;
      };
      expire_stale_jobs: {
        Args: Record<string, never>;
        Returns: number;
      };
      get_ambiguous_jobs: {
        Args: { p_device_id: string };
        Returns: {
          job_id: string;
          attempt_id: string;
          state: JobState;
          claimed_at: string;
        }[];
      };
      redeem_enrollment_invitation: {
        Args: {
          p_token_hash: string;
          p_org_id: string;
          p_device_id: string;
          p_hostname: string;
          p_os: string;
          p_agent_version: string;
          p_display_name: string;
        };
        Returns: string;
      };
      auth_org_role: {
        Args: { org_id: string };
        Returns: MemberRole;
      };
      auth_has_role: {
        Args: { org_id: string; min_role: MemberRole };
        Returns: boolean;
      };
    };
    Enums: {
      member_role: MemberRole;
      enrollment_status: EnrollmentStatus;
      job_state: JobState;
      script_type: ScriptType;
      attempt_outcome: AttemptOutcome;
      actor_type: ActorType;
    };
  };
}
