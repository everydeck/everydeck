/**
 * Heartbeat interval when the app names none: every 300 s (5 minutes), like UptimeRobot Free. everydeck reports an instance or a job as silent
 * after two missed intervals (2 × interval + 30 s) and judges each by the interval its heartbeat reports (`interval_seconds`).
 */
export const DEFAULT_HEARTBEAT_SECONDS = 300;
