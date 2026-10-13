package interfaces

import (
	"encoding/json"
	"testing"
)

func TestOptionContractJSONMarksUnknownVolumeAndOpenInterest(t *testing.T) {
	contract := OptionContract{Symbol: "AAPL261106C00200000", LatestTradeSize: 7, VolumeBasis: "unknown; latest trade size is not daily volume"}
	b, err := json.Marshal(contract)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(b, &value); err != nil {
		t.Fatal(err)
	}
	if _, exists := value["Volume"]; exists {
		t.Fatalf("unknown volume serialized: %s", b)
	}
	if _, exists := value["OpenInterest"]; exists {
		t.Fatalf("unknown OI serialized: %s", b)
	}
	if value["OpenInterestPresent"] != false {
		t.Fatalf("unknown OI flag missing: %s", b)
	}
	if value["latest_trade_size"] != float64(7) {
		t.Fatalf("latest trade size missing: %s", b)
	}
	if value["volume_known"] != false {
		t.Fatalf("volume availability missing: %s", b)
	}
	if value["volume_basis"] != "unknown; latest trade size is not daily volume" {
		t.Fatalf("volume basis missing: %s", b)
	}

	for _, tc := range []struct {
		name string
		oi   int64
	}{{"known-zero", 0}, {"known-positive", 19}} {
		t.Run(tc.name, func(t *testing.T) {
			known := OptionContract{OpenInterest: tc.oi, OpenInterestPresent: true}
			encoded, err := json.Marshal(known)
			if err != nil {
				t.Fatal(err)
			}
			var got map[string]any
			if err = json.Unmarshal(encoded, &got); err != nil {
				t.Fatal(err)
			}
			if got["OpenInterest"] != float64(tc.oi) || got["OpenInterestPresent"] != true {
				t.Fatalf("known OI JSON=%s", encoded)
			}
		})
	}
	for _, tc := range []struct {
		name   string
		volume int64
	}{{"known-zero", 0}, {"known-positive", 7}} {
		t.Run("volume-"+tc.name, func(t *testing.T) {
			known := OptionContract{Volume: tc.volume, VolumeKnown: true}
			encoded, err := json.Marshal(known)
			if err != nil {
				t.Fatal(err)
			}
			var got map[string]any
			if err = json.Unmarshal(encoded, &got); err != nil {
				t.Fatal(err)
			}
			if got["Volume"] != float64(tc.volume) || got["volume_known"] != true {
				t.Fatalf("known volume JSON=%s", encoded)
			}
		})
	}
}
