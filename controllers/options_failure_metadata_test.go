package controllers

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestWithFailureReasonPreservesAuditAndRecordsReason(t *testing.T) {
	audit := `{"decision":"FAIL","blocking_reasons":["signal_direction"]}`
	got := withFailureReason(audit, "rejected_before_submission", errors.New("assessment failed"))
	var doc map[string]json.RawMessage
	if err := json.Unmarshal([]byte(got), &doc); err != nil {
		t.Fatal(err)
	}
	if string(doc["decision"]) != `"FAIL"` || !strings.Contains(string(doc["op2_failure"]), "assessment failed") {
		t.Fatalf("unexpected metadata: %s", got)
	}
	empty := withFailureReason("", "submit_failed", errors.New("provider unavailable"))
	if !strings.Contains(empty, `"op2_failure"`) || !strings.Contains(empty, "provider unavailable") {
		t.Fatalf("empty metadata: %s", empty)
	}
	if got := withFailureReason("not json", "submit_failed", errors.New("x")); got != "not json" {
		t.Fatalf("non-JSON metadata must be left alone, got %q", got)
	}
	long := withFailureReason("", "submit_failed", errors.New(strings.Repeat("x", 2000)))
	if len(long) > 700 {
		t.Fatalf("reason not truncated: %d", len(long))
	}
}
