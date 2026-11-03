package controllers

import (
	"encoding/json"
	"testing"
	"time"
)

func TestHandleGetBarsReportsFeedAndCompleteness(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	data := &recordingBars{}
	r := requestBars(t, "start=2026-03-09&end=2026-03-09&timeframe=1Day", data)
	if r.Code != 200 {
		t.Fatalf("status = %d body=%s", r.Code, r.Body.String())
	}
	var body struct {
		Feed string `json:"feed"`
		Note string `json:"completeness_note"`
		Bars []struct {
			Symbol   string `json:"Symbol"`
			Complete *bool  `json:"complete"`
		} `json:"bars"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Feed != "iex" || body.Note == "" || len(body.Bars) != 1 || body.Bars[0].Symbol != "X" || body.Bars[0].Complete == nil {
		t.Fatalf("unexpected bars body: %+v", body)
	}
	_ = loc
	r = requestBars(t, "start=2026-03-09&end=2026-03-09&timeframe=1Week", &recordingBars{})
	var weekly map[string]any
	if err := json.Unmarshal(r.Body.Bytes(), &weekly); err != nil {
		t.Fatal(err)
	}
	if _, has := weekly["completeness_note"]; has {
		t.Fatalf("weekly bars must not be annotated: %v", weekly)
	}
}
