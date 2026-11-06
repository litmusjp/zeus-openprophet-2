package services

import "time"

// The golden receipts and many fixtures use AAPL261106C00200000, an option that expires 2026-11-06. On that
// date the real-clock 0DTE rule rejected the fixture, which turned unrelated suites red. Pin the policy clock
// to the fixtures' own frozen time (2026-10-06) for every test in this package.
func init() {
	PolicyNow = func() time.Time { return time.Date(2026, 10, 6, 15, 0, 0, 0, time.UTC) }
}
