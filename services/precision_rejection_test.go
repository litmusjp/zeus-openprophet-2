package services

import (
	"encoding/json"
	"strings"
	"testing"

	"prophet-trader/interfaces"
)

const precisionTestMetadata = `{"op2_failure":{"status":"submission_uncertain","reason":"submission_uncertain: broker submission result is unknown: failed to place options order with client_order_id c1: limit price must be limited to 2 decimal places (HTTP 422, Code 42210000)"},"keep":1}`

func precisionTestOrder() *interfaces.Order {
	return &interfaces.Order{ClientOrderID: "c1", PaperLive: "paper", Status: "submission_uncertain", SubmissionAttempted: true, Metadata: precisionTestMetadata}
}

func TestHasPrecisionRejectionEvidenceRequiresEveryCondition(t *testing.T) {
	if !HasPrecisionRejectionEvidence(precisionTestOrder()) {
		t.Fatal("exact evidence was not recognised")
	}
	cases := map[string]func(*interfaces.Order){
		"nil metadata": func(o *interfaces.Order) { o.Metadata = "" },
		"other 422": func(o *interfaces.Order) {
			o.Metadata = strings.Replace(o.Metadata, "limit price must be limited to 2 decimal places", "client_order_id must be unique", 1)
		},
		"other status code":  func(o *interfaces.Order) { o.Metadata = strings.Replace(o.Metadata, "HTTP 422", "HTTP 400", 1) },
		"other error code":   func(o *interfaces.Order) { o.Metadata = strings.Replace(o.Metadata, "42210000", "42210002", 1) },
		"not uncertain":      func(o *interfaces.Order) { o.Status = "submit_failed" },
		"has broker id":      func(o *interfaces.Order) { o.ID = "b1" },
		"has a fill":         func(o *interfaces.Order) { o.FilledQty = 1 },
		"no client order id": func(o *interfaces.Order) { o.ClientOrderID = "" },
		"live account":       func(o *interfaces.Order) { o.PaperLive = "live" },
		"unreadable json":    func(o *interfaces.Order) { o.Metadata = "{not json" },
	}
	for name, mutate := range cases {
		o := precisionTestOrder()
		mutate(o)
		if HasPrecisionRejectionEvidence(o) {
			t.Errorf("%s: evidence accepted", name)
		}
	}
	if HasPrecisionRejectionEvidence(nil) {
		t.Error("nil order accepted")
	}
}

func TestMarkPrecisionRejectedKeepsTheRecordAndAddsTheResolution(t *testing.T) {
	o := precisionTestOrder()
	if err := MarkPrecisionRejected(o, "startup_reconciliation"); err != nil {
		t.Fatal(err)
	}
	if o.Status != "rejected" || o.ClientOrderID != "c1" || !o.SubmissionAttempted || o.ID != "" {
		t.Fatalf("record not kept: %#v", o)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal([]byte(o.Metadata), &doc); err != nil {
		t.Fatal(err)
	}
	if string(doc["keep"]) != "1" || len(doc["op2_failure"]) == 0 {
		t.Fatalf("existing metadata lost: %s", o.Metadata)
	}
	var res map[string]string
	if err := json.Unmarshal(doc["resolution"], &res); err != nil {
		t.Fatal(err)
	}
	if res["by"] != "startup_reconciliation" || res["rule"] != PrecisionResolutionRule || res["broker_lookup"] != "not_found" || res["previous_status"] != "submission_uncertain" || res["at"] == "" {
		t.Fatalf("resolution metadata: %v", res)
	}
	// a resolved record no longer qualifies, so it cannot be resolved twice
	if err := MarkPrecisionRejected(o, "operator"); err == nil {
		t.Fatal("a rejected record was resolved again")
	}
	bad := precisionTestOrder()
	bad.Metadata = strings.Replace(bad.Metadata, "42210000", "42210002", 1)
	if err := MarkPrecisionRejected(bad, "operator"); err == nil || bad.Status != "submission_uncertain" {
		t.Fatalf("record without the evidence was changed: %v %#v", err, bad)
	}
}
