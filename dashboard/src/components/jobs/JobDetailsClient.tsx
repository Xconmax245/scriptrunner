"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { JobState } from "@/types/database";
import { XCircle, Loader2, AlertCircle } from "lucide-react";

interface Props {
  jobId: string;
  organizationId: string;
  state: JobState;
}

const CANCELLABLE_STATES: JobState[] = [
  "queued",
  "waiting_for_device",
  "claimed",
  "running",
];

export function JobDetailsClient({ jobId, organizationId, state }: Props) {
  const router = useRouter();
  const supabase = createClient();
  const [cancelling, setCancelling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const canCancel = CANCELLABLE_STATES.includes(state);

  const handleCancel = async () => {
    setCancelling(true);
    setError(null);
    setResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setError("Session expired"); return; }

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/cancel-job`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ job_id: jobId, organization_id: organizationId }),
        }
      );
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Cancellation failed"); return; }
      setResult(data.message);
      setConfirming(false);
      router.refresh();
    } finally {
      setCancelling(false);
    }
  };

  if (!canCancel) return null;

  return (
    <div className="flex items-center gap-2">
      {error && (
        <span className="text-xs text-red-400 flex items-center gap-1">
          <AlertCircle className="w-3.5 h-3.5" /> {error}
        </span>
      )}
      {result && (
        <span className="text-xs text-amber-400">{result}</span>
      )}
      {confirming ? (
        <>
          <span className="text-xs text-gray-400">Cancel this job?</span>
          <button onClick={() => setConfirming(false)} className="btn-ghost btn-sm" disabled={cancelling}>
            No
          </button>
          <button
            onClick={handleCancel}
            className="btn-danger btn-sm"
            disabled={cancelling}
            id="confirm-cancel-job-btn"
          >
            {cancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Yes, Cancel"}
          </button>
        </>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          className="btn-secondary btn-sm"
          id="cancel-job-btn"
        >
          <XCircle className="w-3.5 h-3.5 text-red-400" />
          Cancel Job
        </button>
      )}
      {state === "running" && (
        <p className="text-xs text-amber-400 mt-1">
          Best-effort for running jobs — execution may have already completed.
        </p>
      )}
    </div>
  );
}
