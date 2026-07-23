# Apple Health Shortcut bridge

This is a free temporary bridge while official Garmin API approval is pending.

## Flow

Garmin watch → Garmin Connect → Apple Health → iPhone Shortcut → Rega Tov.

The PWA cannot read HealthKit directly. The Shortcut reads only the categories you approve and sends a daily JSON summary to the Worker.

## Security

- Create a personal key in Settings.
- The raw key is displayed only once.
- The database stores only its SHA-256 hash.
- The Shortcut sends `Authorization: Bearer YOUR_KEY`.
- Replacing or disconnecting the key invalidates the previous key.
- Never place the raw key in GitHub, source code, screenshots, or support messages.

## Example JSON

```json
{
  "schemaVersion": 1,
  "localDate": "2026-07-23",
  "generatedAt": "2026-07-23T20:00:00+03:00",
  "timezone": "Asia/Jerusalem",
  "steps": 10234,
  "activeEnergyKcal": 740,
  "restingEnergyKcal": 1620,
  "walkingRunningDistanceKm": 8.4,
  "flightsClimbed": 7,
  "restingHeartRateBpm": 52,
  "averageHeartRateBpm": 71,
  "sleepMinutes": 431,
  "weightKg": 62.5,
  "bodyFatPercentage": 15.2
}
```

All metrics except `localDate` are optional.

## Shortcut outline

1. Sync the Garmin watch while Garmin Connect is open.
2. Allow Garmin Connect to write the desired categories into Apple Health.
3. Create a Shortcut named `Sync Garmin to Rega Tov`.
4. Use `Find Health Samples` for today's data.
5. Calculate totals or select the latest value.
6. Build a Dictionary using the supported JSON keys.
7. Add `Get Contents of URL`.
8. Use the import URL shown in Rega Tov Settings.
9. Set Method to POST and Request Body to JSON.
10. Add header `Authorization` with `Bearer ` followed by the personal key.
11. Run it once and approve Health permissions.
12. Confirm that Settings shows the last successful sync.

The endpoint also accepts an optional `workouts` array containing `workoutType`, `startAt`, `endAt`, `durationMinutes`, and optional calories, distance, and heart-rate values.
