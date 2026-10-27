// Edge Function: cancel-job
// Allows admin to cancel a queued or running job.
// verify_jwt = true
import { createClient } from "jsr:@supabase/supabase-js@2";
import { z } from "npm:zod@3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const schema = z.object({
  job_id: z.string().uuid(),
  organization_id: z.string().uuid(),
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing authorization" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  const supabaseUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: { user }, error: userErr } = await supabaseUser.auth.getUser();
  if (userErr || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Validation failed" }), {
      status: 422,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const { job_id, organization_id } = parsed.data;

  // Verify membership and minimum administrator role
  const { data: member } = await supabaseAdmin
    .from("organization_members")
    .select("role")
    .eq("organization_id", organization_id)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "administrator"].includes(member.role)) {
    return new Response(JSON.stringify({ error: "Forbidden: insufficient role" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const { data: result, error: rpcErr } = await supabaseAdmin.rpc("cancel_job", {
    p_job_id: job_id,
    p_actor_user_id: user.id,
    p_org_id: organization_id,
  });

  if (rpcErr) {
    return new Response(JSON.stringify({ error: "Cancellation failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const resultStr = result as string;
  if (resultStr === "not_found") {
    return new Response(JSON.stringify({ error: "Job not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Audit log
  await supabaseAdmin.from("audit_events").insert({
    organization_id,
    actor_type: "user",
    actor_id: user.id,
    action: "job.cancelled",
    target_type: "job",
    target_id: job_id,
    metadata: { cancellation_result: resultStr },
    ip_address: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  return new Response(
    JSON.stringify({
      result: resultStr,
      best_effort: resultStr === "best_effort_running",
      message: resultStr === "best_effort_running"
        ? "Job was running when cancel was requested. State set to cancelled but execution may have completed. Verify the attempt record."
        : resultStr === "already_terminal"
        ? "Job was already in a terminal state."
        : "Job cancelled successfully.",
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    }
  );
});
