package controllers

import (
	"encoding/json"
	"strings"
)

const maxFailureReasonLen = 500

// withFailureReason records why an options order did not reach the broker (or was rejected by it)
// inside the order row's existing audit Metadata JSON, so failed rows are diagnosable later. It
// preserves any assessment audit already stored there and never fails the order path.
func withFailureReason(metadata, status string, reason error) string {
	if reason == nil {
		return metadata
	}
	text := strings.TrimSpace(reason.Error())
	if len(text) > maxFailureReasonLen {
		text = text[:maxFailureReasonLen]
	}
	doc := map[string]json.RawMessage{}
	if strings.TrimSpace(metadata) != "" {
		if err := json.Unmarshal([]byte(metadata), &doc); err != nil || doc == nil {
			return metadata
		}
	}
	failure, err := json.Marshal(map[string]string{"status": status, "reason": text})
	if err != nil {
		return metadata
	}
	doc["op2_failure"] = failure
	out, err := json.Marshal(doc)
	if err != nil {
		return metadata
	}
	return string(out)
}
