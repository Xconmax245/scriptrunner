import { NextRequest, NextResponse } from "next/server";
import {
  getAllDeployments,
  cancelDeployment,
  retryDeployment,
  getDeploymentById,
} from "@/lib/rmm/deploymentStore";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const list = await getAllDeployments();
    return NextResponse.json({ deployments: list });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { action, job_id } = body;

    if (!job_id) {
      return NextResponse.json({ error: "job_id is required" }, { status: 400 });
    }

    if (action === "cancel") {
      const ok = await cancelDeployment(job_id);
      return NextResponse.json({ success: ok });
    }

    if (action === "retry") {
      const ok = await retryDeployment(job_id);
      return NextResponse.json({ success: ok });
    }

    if (action === "get") {
      const job = await getDeploymentById(job_id);
      return NextResponse.json({ job });
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
