import { apiRequest, syncPendingMutations } from "../app/api";
import { listPendingCaptures, removeCapture, updateCapture } from "./db";

export async function syncOfflineWork(
  onProgress?: (message: string) => void,
): Promise<{ mutations: number; captures: number }> {
  if (!navigator.onLine) return { mutations: 0, captures: 0 };
  const mutations = await syncPendingMutations();
  const captures = await listPendingCaptures();
  let captureCount = 0;
  for (const capture of captures) {
    onProgress?.("מעלה ארוחה שנשמרה ללא רשת…");
    await updateCapture({ ...capture, status: "syncing" });
    try {
      const job = await apiRequest<{ jobId: string }>("/api/v1/analysis/jobs", {
        method: "POST",
        body: JSON.stringify({ clientMutationId: capture.id, jobType: "meal" }),
      });
      for (const [index, blob] of capture.files.entries()) {
        await apiRequest(`/api/v1/analysis/jobs/${job.jobId}/images/${index}`, {
          method: "PUT",
          headers: { "content-type": blob.type || "image/jpeg" },
          body: blob,
        });
      }
      await apiRequest(`/api/v1/analysis/jobs/${job.jobId}/start`, { method: "POST" });
      await removeCapture(capture.id);
      captureCount += 1;
    } catch {
      await updateCapture({ ...capture, status: "failed" });
      break;
    }
  }
  return { mutations, captures: captureCount };
}
