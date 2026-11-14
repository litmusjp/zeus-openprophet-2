package interfaces

import "time"

// DailyLossLockStatus describes the per-session daily-loss lock on new openings.
// Locked is true when the limit was reached earlier in the current broker session; the lock lasts until the
// next broker session date. It never restricts closing or reducing orders.
type DailyLossLockStatus struct {
	Enabled        bool      `json:"enabled"`
	Locked         bool      `json:"locked"`
	NewlyLocked    bool      `json:"newly_locked"`
	SessionDate    string    `json:"session_date,omitempty"`
	LossPct        float64   `json:"loss_pct,omitempty"`
	LimitPct       float64   `json:"limit_pct,omitempty"`
	LatchedAt      time.Time `json:"latched_at,omitempty"`
	ClockAvailable bool      `json:"clock_available"`
}
