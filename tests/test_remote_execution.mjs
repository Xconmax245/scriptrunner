import http from "http";
import { spawn } from "child_process";

async function runTest() {
  console.log("=== STEP 1: Submitting Job via Dashboard API ===");
  const jobPayload = JSON.stringify({
    organization_id: "00000000-0000-0000-0000-000000000001",
    device_id: "b37a3eb0-8e39-4c5b-8c86-38d68a4bf379",
    script_content: 'Write-Output "=== REMOTE POWERSHELL RUNNER ==="\nGet-Date\nWrite-Output "Agent Hostname: $env:COMPUTERNAME"\nWrite-Output "User Domain: $env:USERDOMAIN"\nWrite-Output "Script Execution SUCCESS"',
    script_type: "powershell",
    description: "Automated Verification Job",
    timeout_seconds: 60,
  });

  const submitRes = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "localhost",
        port: 3000,
        path: "/api/jobs",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(jobPayload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
      }
    );
    req.on("error", reject);
    req.write(jobPayload);
    req.end();
  });

  console.log("Job Submission Status:", submitRes.status);
  const jobId = submitRes.data.job_id || submitRes.data.id;

  console.log("\n=== STEP 2: Running ScriptRunnerAgent ===");
  const agent = spawn("c:\\Users\\USER\\Downloads\\.EXE\\agent\\publish\\ScriptRunnerAgent.exe", [], {
    cwd: "c:\\Users\\USER\\Downloads\\.EXE\\agent\\publish",
  });

  agent.stdout.on("data", (d) => process.stdout.write("[AGENT] " + d));
  agent.stderr.on("data", (d) => process.stderr.write("[AGENT ERR] " + d));

  // Allow agent to poll, claim, execute, and report result
  await new Promise((r) => setTimeout(r, 12000));
  agent.kill();

  console.log("\n=== STEP 3: Checking Job Status in Supabase ===");
  const serviceKey =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoYmFkZm9wZm9sd3dvb3F6emJiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MjY4MTU0NiwiZXhwIjoyMTA4MjU3NTQ2fQ.476X_U_GUwgFRJQpwIf9sZV9JDrk4b0llJkeGnzolYE";
  const checkRes = await fetch(
    `https://uhbadfopfolwwooqzzbb.supabase.co/rest/v1/jobs?id=eq.${jobId}&select=*,job_attempts(*)`,
    {
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
    }
  );
  const jobRows = await checkRes.json();
  const job = jobRows[0];
  console.log("Job State:", job.state);
  console.log("Job Completed At:", job.completed_at);
  if (job.job_attempts && job.job_attempts.length > 0) {
    const attempt = job.job_attempts[0];
    console.log("Attempt State:", attempt.state);
    console.log("Exit Code:", attempt.exit_code);
    console.log("Stdout:\n" + attempt.stdout_text);
    if (attempt.stderr_text) {
      console.log("Stderr:\n" + attempt.stderr_text);
    }
  }
}

runTest().catch(console.error);
