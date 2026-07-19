import { NavLink } from "react-router-dom";

export function BottomNavigation(): React.JSX.Element {
  return (
    <nav className="bottom-nav" aria-label="פעולה ראשית">
      <NavLink
        to="/add"
        className={({ isActive }) =>
          `bottom-nav__item bottom-nav__item--central${isActive ? " is-active" : ""}`
        }
        aria-label="הוספת ארוחה"
      >
        <span className="bottom-nav__icon" aria-hidden="true">
          +
        </span>
        <span>הוספה</span>
      </NavLink>
    </nav>
  );
}
