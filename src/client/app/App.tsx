import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
import { loadSession } from "./api";
import { AppShell } from "../components/AppShell";
import { LoginPage } from "../features/auth/LoginPage";
import { HomePage } from "../features/diary/HomePage";
import { DiaryPage } from "../features/diary/DiaryPage";
import { CapturePage } from "../features/capture/CapturePage";
import { AnalysisReviewPage } from "../features/capture/AnalysisReviewPage";
import { CoachPage } from "../features/coach/CoachPage";
import { ProgressPage } from "../features/progress/ProgressPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { ShoppingPage } from "../features/shopping/ShoppingPage";
import { ProductsPage } from "../features/products/ProductsPage";
import { syncOfflineWork } from "../offline/sync";

export function App(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const sessionQuery = useQuery({ queryKey: ["session"], queryFn: loadSession });

  useEffect(() => {
    if (!sessionQuery.data?.authenticated) return;
    const sync = (): void => {
      void syncOfflineWork(setSyncMessage).then((result) => {
        if (result.captures + result.mutations > 0) {
          setSyncMessage("הסנכרון הושלם");
          void queryClient.invalidateQueries();
          window.setTimeout(() => setSyncMessage(null), 2_000);
        } else setSyncMessage(null);
      });
    };
    sync();
    window.addEventListener("online", sync);
    return () => window.removeEventListener("online", sync);
  }, [queryClient, sessionQuery.data?.authenticated]);

  if (sessionQuery.isLoading)
    return (
      <div className="launch-screen">
        <span className="launch-screen__mark">◒</span>
        <p>פותחים את היום שלך…</p>
      </div>
    );
  if (!sessionQuery.data)
    return (
      <div className="error-page">
        <h1>לא הצלחנו לפתוח את האפליקציה</h1>
        <button
          onClick={() => {
            void sessionQuery.refetch();
          }}
        >
          נסה שוב
        </button>
      </div>
    );
  if (!sessionQuery.data.authenticated) return <LoginPage session={sessionQuery.data} />;

  return (
    <>
      {syncMessage && (
        <div className="sync-banner" role="status">
          {syncMessage}
        </div>
      )}
      {!navigator.onLine && (
        <div className="offline-banner" role="status">
          אין חיבור כרגע — אפשר להמשיך לתעד
        </div>
      )}
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<HomePage />} />
          <Route path="diary" element={<DiaryPage />} />
          <Route path="add" element={<CapturePage />} />
          <Route path="analysis/:jobId" element={<AnalysisReviewPage />} />
          <Route path="coach" element={<CoachPage />} />
          <Route path="progress" element={<ProgressPage />} />
          <Route path="shopping" element={<ShoppingPage />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </>
  );
}
