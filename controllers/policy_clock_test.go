package controllers

import (
	"time"

	"prophet-trader/services"
)

// Same pin as in the services package: fixtures use an option expiring 2026-11-06, which the real-clock
// 0DTE rule would reject on that date.
func init() {
	services.PolicyNow = func() time.Time { return time.Date(2026, 10, 6, 15, 0, 0, 0, time.UTC) }
}
