import { NavLink } from "react-router-dom";

const items: ReadonlyArray<{ to: string; label: string; icon: string; central?: boolean }> = [
  { to: "/", label: "היום", icon: "◴" },
  { to: "/diary", label: "יומן", icon: "☰" },
  { to: "/add", label: "הוספה", icon: "+", central: true },
  { to: "/coach", label: "הכוונה", icon: "↗" },
  { to: "/progress", label: "התקדמות", icon: "∿" },
];

export function BottomNavigation(): React.JSX.Element {
  return (
    <nav className="bottom-nav" aria-label="ניווט ראשי">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === "/"}
          className={({ isActive }) =>
            `bottom-nav__item${item.central ? " bottom-nav__item--central" : ""}${isActive ? " is-active" : ""}`
          }
        >
          <span className="bottom-nav__icon" aria-hidden="true">
            {item.icon}
          </span>
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
