//go:build windows

package services

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

// Windows uses the kernel byte-range lock on a durable account-scoped file.
// The handle remains open for the entire reservation transaction, so another
// process cannot enter the same account reservation critical section.
func acquireAccountReservationLock(path string) (func(), error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("open account reservation lock: %w", err)
	}
	overlapped := new(windows.Overlapped)
	if err := windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, overlapped); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("acquire account reservation lock: %w", err)
	}
	return func() {
		_ = windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, overlapped)
		_ = file.Close()
	}, nil
}
