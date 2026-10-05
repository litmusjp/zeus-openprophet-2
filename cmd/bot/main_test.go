package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestExecutionModeEnabledFailsClosed(t *testing.T) {
	cases := []struct {
		mode string
		want bool
	}{
		{"", false},
		{"inert", false},
		{"true", false},
		{"paper", true},
		{"PAPER ", true},
		{"ENABLED ", true},
		{"enabled", true},
	}
	for _, tc := range cases {
		if got := executionModeEnabled(tc.mode); got != tc.want {
			t.Fatalf("executionModeEnabled(%q) = %v, want %v", tc.mode, got, tc.want)
		}
	}
}

func TestInertStartupDoesNotBindOrStartRuntime(t *testing.T) {
	if shouldStartHTTPServer(false) {
		t.Fatal("inert startup must not bind an HTTP port")
	}
	if !shouldStartHTTPServer(true) {
		t.Fatal("enabled startup must retain HTTP server behavior")
	}
}

func TestRegisteredHealthRouteUsesCurrentReadinessSnapshot(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for key, value := range map[string]string{
		"OPENPROPHET_SANDBOX_ID": "sandbox", "OPENPROPHET_ACCOUNT_ID": "account", "ALPACA_ACCOUNT_ID": "broker",
		"OPENPROPHET_PROCESS_NONCE": "nonce", "OPENPROPHET_RECONCILIATION_COMPLETE": "true",
		"OPENPROPHET_EXECUTION_BLOCKED": "false", "OPENPROPHET_EXECUTION_ENABLED": "true", "OPENPROPHET_BROKER_READY": "true",
	} {
		t.Setenv(key, value)
	}
	request := func(accountErr bool, orderBlock, managedBlock bool) (int, map[string]any) {
		router := gin.New()
		registerHealthRoute(router, func() error {
			if accountErr {
				return errHealthBrokerUnavailable
			}
			return nil
		}, func() bool { return orderBlock }, func() bool { return managedBlock })
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest("GET", "/health", nil))
		var response map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		return recorder.Code, response
	}
	code, body := request(false, false, true)
	if code != 503 || body["ready"] != false || body["execution_blocked"] != true || body["execution_blocked_startup_diagnostic"] != false {
		t.Fatalf("blocked health = %d %v", code, body)
	}
	code, body = request(false, false, false)
	if code != 200 || body["ready"] != true || body["execution_blocked"] != false {
		t.Fatalf("ready health = %d %v", code, body)
	}
	code, body = request(true, false, false)
	if code != 503 || body["ready"] != false || len(body["readiness_reasons"].([]any)) == 0 {
		t.Fatalf("broker unavailable health = %d %v", code, body)
	}
	t.Setenv("OPENPROPHET_ACCOUNT_ID", "")
	code, body = request(false, false, false)
	if code != 503 || body["ready"] != false || len(body["readiness_reasons"].([]any)) == 0 {
		t.Fatalf("missing identity health = %d %v", code, body)
	}
}

var errHealthBrokerUnavailable = fmt.Errorf("broker unavailable")
