import { Link, Outlet } from "react-router-dom";
import { BottomNavigation } from "./BottomNavigation";

export function AppShell(): React.JSX.Element {
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="רגע טוב — דף הבית">
          <span className="brand__mark" aria-hidden="true">
            ◒
          </span>
          <span>רגע טוב</span>
        </Link>
        <Link className="profile-link" to="/settings" aria-label="הגדרות ופרופיל">
          אני
        </Link>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
      <BottomNavigation />
    </div>
  );
}
