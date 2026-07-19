import { useEffect, useRef } from "react";
import { NavLink } from "react-router-dom";

const items: ReadonlyArray<{
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}> = [
  { to: "/", label: "היום", icon: "◴", end: true },
  { to: "/diary", label: "יומן", icon: "☰" },
  { to: "/products", label: "מוצרים", icon: "▦" },
  { to: "/coach", label: "הכוונה", icon: "↗" },
  { to: "/progress", label: "התקדמות", icon: "∿" },
  { to: "/shopping", label: "רשימת קניות", icon: "✓" },
  { to: "/settings", label: "הגדרות ופרופיל", icon: "⚙" },
];

type SideNavigationProps = {
  open: boolean;
  onClose: () => void;
};

export function SideNavigation({
  open,
  onClose,
}: SideNavigationProps): React.JSX.Element | null {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    window.setTimeout(() => closeButtonRef.current?.focus(), 0);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="side-menu-layer">
      <button
        className="side-menu-backdrop"
        type="button"
        aria-label="סגירת התפריט"
        onClick={onClose}
      />
      <aside
        id="side-navigation"
        className="side-menu"
        role="dialog"
        aria-modal="true"
        aria-label="תפריט ראשי"
      >
        <header className="side-menu__header">
          <div className="side-menu__brand">
            <span aria-hidden="true">◒</span>
            <div>
              <strong>רגע טוב</strong>
              <small>כל האזורים במקום אחד</small>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            className="side-menu__close"
            type="button"
            aria-label="סגירת התפריט"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <nav className="side-menu__links" aria-label="עמודי האפליקציה">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `side-menu__item${isActive ? " is-active" : ""}`
              }
              onClick={onClose}
            >
              <span className="side-menu__icon" aria-hidden="true">
                {item.icon}
              </span>
              <span>{item.label}</span>
              <span className="side-menu__arrow" aria-hidden="true">
                ‹
              </span>
            </NavLink>
          ))}
        </nav>
        <footer className="side-menu__footer">
          כפתור ההוספה נשאר תמיד נגיש במרכז המסך.
        </footer>
      </aside>
    </div>
  );
}
