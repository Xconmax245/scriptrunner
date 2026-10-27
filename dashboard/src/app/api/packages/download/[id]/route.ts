import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { getAllDeployments, getPackageFilePath } from "@/lib/rmm/deploymentStore";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const token = searchParams.get("token");

    const deployments = await getAllDeployments();
    const matchingJob = deployments.find(
      (j) => j.package_id === id || j.id === id
    );

    if (!matchingJob) {
      return new NextResponse("Package not found", { status: 404 });
    }

    if (token && matchingJob.download_token && token !== matchingJob.download_token) {
      return new NextResponse("Unauthorized download token", { status: 403 });
    }

    const filePath = await getPackageFilePath(matchingJob.storage_path);
    if (!filePath || !fsSync.existsSync(filePath)) {
      return new NextResponse("Package binary missing from repository", { status: 404 });
    }

    const stat = await fs.stat(filePath);
    const fileStream = fsSync.createReadStream(filePath);

    // ReadableStream from Node read stream
    const webStream = new ReadableStream({
      start(controller) {
        fileStream.on("data", (chunk) => controller.enqueue(chunk));
        fileStream.on("end", () => controller.close());
        fileStream.on("error", (err) => controller.error(err));
      },
      cancel() {
        fileStream.destroy();
      },
    });

    const headers = new Headers();
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Length", stat.size.toString());
    headers.set("ETag", matchingJob.sha256);
    headers.set("Content-Disposition", `attachment; filename="${matchingJob.file_name}"`);

    return new NextResponse(webStream, {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Error serving package download:", error);
    return new NextResponse(error.message || "Download error", { status: 500 });
  }
}
