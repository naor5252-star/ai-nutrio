# Design System, Visual Identity and Accessibility

## Internal directions evaluated

1. **Nutrition dashboard:** efficient but looked too analytical and card-heavy.
2. **Conversational companion:** friendly but too similar to a generic chatbot.
3. **Food moments timeline:** diary-first, camera-centered, supports food photography and uncertainty without professional jargon.

Direction 3 was selected.

## Identity: “רגע טוב”

The interface treats meals as moments in the day rather than spreadsheet rows. The home view combines a vertical meal rhythm, a “remaining today” composition and a compact next-action coach. AI is represented by action and context, not sparkle branding or a full-screen chat clone.

## Core patterns

- **Camera-centered entry:** prominent bottom-thumb action with visible fallback to photo library/manual entry.
- **Pending meal:** appears in the timeline immediately; processing is a diary state, not a technical job screen.
- **Confirmation surface:** each component exposes food, quantity, unit and confidence separately.
- **Provenance markers:** “מהתווית”, “מהמאגר”, “הוזן ידנית”, “הערכה”. Meaning is never color-only.
- **Unknown values:** displayed as `לא ידוע`; partial totals explain what was excluded.
- **Progressive disclosure:** formulas, source conflicts, micronutrients and model routes stay in expandable details.

## RTL and mixed-direction content

- Root uses `lang="he" dir="rtl"`.
- CSS uses logical properties (`margin-inline`, `padding-block`, `inset-inline`).
- Numeric values and units use isolated inline spans where needed, preserving forms such as `1,850 kcal`, `1.6 גרם/ק״ג` and `75%`.
- Charts and timelines order dates chronologically while labels align for RTL reading.

## Accessibility guidelines

- Minimum practical 44×44 CSS-pixel touch targets.
- Native controls and semantic landmarks before custom widgets.
- Visible `:focus-visible` state and full keyboard operation.
- Form errors attached with `aria-describedby`; status changes use polite live regions.
- Confidence/source state includes text and icon, not color alone.
- `prefers-reduced-motion` disables non-essential transitions.
- Text scales with browser settings; essential labels are not fixed to tiny sizes.
- Every chart must provide an adjacent textual summary.
- Push permission is requested only after an explicit user action.

## Content tone

Use short, supportive Hebrew: “בדוק את הזיהוי”, “אפשר לתקן לפני השמירה”, “נשמור כשהאינטרנט יחזור”. Avoid “bad food”, failure, punishment and compensation language.
