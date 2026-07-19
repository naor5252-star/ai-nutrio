import { useCallback, useState } from "react";
import { Link, Outlet } from "react-router-dom";
import { BottomNavigation } from "./BottomNavigation";
import { SideNavigation } from "./SideNavigation";

export function AppShell(): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          className="menu-toggle"
          type="button"
          aria-label="פתיחת התפריט"
          aria-expanded={menuOpen}
          aria-controls="side-navigation"
          onClick={() => setMenuOpen(true)}
        >
          <span />
          <span />
          <span />
        </button>
        <Link to="/" className="brand" aria-label="רגע טוב — דף הבית">
          <span className="brand__mark" aria-hidden="true">
            ◒
          </span>
          <span>רגע טוב</span>
        </Link>
        <span className="topbar__spacer" aria-hidden="true" />
      </header>
      <main className="app-main">
        <Outlet />
      </main>
      <SideNavigation open={menuOpen} onClose={closeMenu} />
      <BottomNavigation />
    </div>
  );
}
