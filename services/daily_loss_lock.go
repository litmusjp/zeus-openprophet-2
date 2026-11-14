package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"prophet-trader/interfaces"
)

// dailyLossLockStaleAfter bounds how long a stored lock is trusted when the broker clock is unavailable.
const dailyLossLockStaleAfter = 36 * time.Hour

// DailyLossLock is the persisted record that the daily-loss limit was reached during a regular session.
// While it matches the current broker session date, new openings are refused; closing and reducing orders,
// research and reconciliation are never affected. It is cleared only by a new broker session date.
type DailyLossLock struct {
	SessionDate string    `json:"session_date"`
	LossPct     float64   `json:"loss_pct"`
	LimitPct    float64   `json:"limit_pct"`
	LatchedAt   time.Time `json:"latched_at"`
	AccountID   string    `json:"account_id,omitempty"`
	SandboxID   string    `json:"sandbox_id,omitempty"`
}

type dailyLossLockFile struct {
	Lock *DailyLossLock `json:"lock"`
}

// DailyLossLockStore keeps the lock in a small JSON file next to the sandbox database.
type DailyLossLockStore struct {
	mu   sync.Mutex
	path string
}

func NewDailyLossLockStore(path string) *DailyLossLockStore {
	return &DailyLossLockStore{path: path}
}

// Load returns nil when no lock has been stored.
func (st *DailyLossLockStore) Load() (*DailyLossLock, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	data, err := os.ReadFile(st.path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("daily loss lock unreadable: %w", err)
	}
	var file dailyLossLockFile
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, fmt.Errorf("daily loss lock corrupt: %w", err)
	}
	return file.Lock, nil
}

// Save writes the lock atomically.
func (st *DailyLossLockStore) Save(lock DailyLossLock) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	data, err := json.MarshalIndent(dailyLossLockFile{Lock: &lock}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(st.path), 0o755); err != nil {
		return err
	}
	tmp := st.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, st.path)
}

// SetDailyLossLockStore binds the durable lock store to the trading service.
func (s *AlpacaTradingService) SetDailyLossLockStore(store *DailyLossLockStore) {
	s.dailyLossLock = store
}

// NewYorkSessionDate is the exchange-local calendar date of a broker timestamp.
func NewYorkSessionDate(t time.Time) string {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		return t.UTC().Format("2006-01-02")
	}
	return t.In(loc).Format("2006-01-02")
}

// evaluateDailyLossLock reads the stored lock and, when set is true and the regular session is open,
// latches a new lock if the account's loss has reached the policy limit. A nil account is fetched only when needed.
// It reuses the broker equity fields the policy already reads; there is no second percentage calculation.
func (s *AlpacaTradingService) evaluateDailyLossLock(ctx context.Context, set bool, account *interfaces.Account) (*interfaces.DailyLossLockStatus, error) {
	if s.dailyLossLock == nil {
		return &interfaces.DailyLossLockStatus{Enabled: false, ClockAvailable: true}, nil
	}
	limit := 0.0
	if s.policy != nil {
		limit = s.policy.MaxDailyLoss
	}
	status := &interfaces.DailyLossLockStatus{Enabled: limit > 0, LimitPct: limit}
	lock, err := s.dailyLossLock.Load()
	if err != nil {
		return nil, err
	}
	clock, clockErr := s.GetMarketClock(ctx)
	status.ClockAvailable = clockErr == nil && clock != nil && !clock.Timestamp.IsZero()
	sessionDate := ""
	if status.ClockAvailable {
		sessionDate = NewYorkSessionDate(clock.Timestamp)
		status.SessionDate = sessionDate
	}
	if lock != nil {
		stored := lock.SessionDate == sessionDate
		unknownClockRecent := !status.ClockAvailable && time.Since(lock.LatchedAt) < dailyLossLockStaleAfter
		if stored || unknownClockRecent {
			status.Locked = true
			status.LossPct = lock.LossPct
			status.LatchedAt = lock.LatchedAt
			if status.SessionDate == "" {
				status.SessionDate = lock.SessionDate
			}
		}
	}
	if status.Locked || !set || limit <= 0 || !status.ClockAvailable || !clock.IsOpen {
		return status, nil
	}
	if account == nil {
		account, err = s.GetAccount(ctx)
		if err != nil {
			return status, nil
		}
	}
	if account == nil || !account.DailyPnLValid || account.DailyPnL >= 0 {
		return status, nil
	}
	lossPct := -account.DailyPnLPercent
	if lossPct < limit {
		return status, nil
	}
	record := DailyLossLock{SessionDate: sessionDate, LossPct: lossPct, LimitPct: limit, LatchedAt: time.Now().UTC(), AccountID: s.expectedAccountID, SandboxID: s.expectedSandboxID}
	if err := s.dailyLossLock.Save(record); err != nil {
		return nil, fmt.Errorf("daily loss lock could not be saved: %w", err)
	}
	status.Locked = true
	status.NewlyLocked = true
	status.LossPct = lossPct
	status.LatchedAt = record.LatchedAt
	return status, nil
}

// EvaluateDailyLossLock checks the limit during the open session and latches the lock when it is reached.
func (s *AlpacaTradingService) EvaluateDailyLossLock(ctx context.Context) (*interfaces.DailyLossLockStatus, error) {
	return s.evaluateDailyLossLock(ctx, true, nil)
}

// DailyLossLockState reports the stored lock without ever setting one.
func (s *AlpacaTradingService) DailyLossLockState(ctx context.Context) (*interfaces.DailyLossLockStatus, error) {
	return s.evaluateDailyLossLock(ctx, false, nil)
}
