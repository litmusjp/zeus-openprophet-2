package controllers

import (
	"context"
	"errors"
	"github.com/gin-gonic/gin"
	"net/http"
	"net/http/httptest"
	"prophet-trader/interfaces"
	"prophet-trader/services"
	"strings"
	"testing"
)

// Unimplemented broker/account methods panic if the read-only route calls them.
type standaloneOnlyService struct {
	interfaces.TradingService
	calls       int
	unavailable bool
}

func (s *standaloneOnlyService) AssessOptionsTradeReadOnly(_ context.Context, p services.StandaloneTradeProposal) (map[string]any, error) {
	s.calls++
	if s.unavailable {
		return nil, errors.New("private upstream detail")
	}
	return map[string]any{"decision": "FAIL", "signal_score": 40, "execution_allowed": false, "remediation": []string{"genuine stronger signal required"}}, nil
}
func TestStandaloneHTTPControllerReadOnlyValidationAndFeedback(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct {
		name, body    string
		status, calls int
		unavailable   bool
	}{
		{"feedback", `{"legs":[{"symbol":"AAPL261106C00200000","side":"buy"}],"quantity":1,"limit_price":2}`, 200, 1, false},
		{"outage", `{"legs":[{"symbol":"AAPL261106C00200000","side":"buy"}],"quantity":1,"limit_price":2}`, 200, 1, true},
		{"caller_score", `{"legs":[{"symbol":"AAPL261106C00200000","side":"buy"}],"quantity":1,"limit_price":2,"signal_score":100}`, 400, 0, false},
		{"invalid_quantity", `{"legs":[{"symbol":"AAPL261106C00200000","side":"buy"}],"quantity":0,"limit_price":2}`, 400, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &standaloneOnlyService{unavailable: tc.unavailable}
			controller := NewOrderController(s, nil, nil)
			r := gin.New()
			r.POST("/options/trade-assessment", controller.AssessOptionsTrade)
			w := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/options/trade-assessment", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			r.ServeHTTP(w, req)
			if w.Code != tc.status || s.calls != tc.calls {
				t.Fatalf("status=%d calls=%d body=%s", w.Code, s.calls, w.Body.String())
			}
			if tc.unavailable && (strings.Contains(w.Body.String(), "private upstream") || !strings.Contains(w.Body.String(), `"decision":"UNAVAILABLE"`)) {
				t.Fatal("unsanitized or misleading outage")
			}
			if tc.unavailable && (!strings.Contains(w.Body.String(), `"source":"unknown"`) || !strings.Contains(w.Body.String(), `"requested_feed":"indicative"`)) {
				t.Fatal("outage claimed an observed provider source")
			}
			if tc.unavailable && (!strings.Contains(w.Body.String(), `"advisory_policy_profile":"paper_advisory_greeks_v1"`) || !strings.Contains(w.Body.String(), `"human_approval_required":true`)) {
				t.Fatal("outage omitted advisory safety metadata")
			}
			if tc.name == "feedback" && !strings.Contains(w.Body.String(), "genuine stronger signal required") {
				t.Fatal("lost assessment feedback")
			}
		})
	}
}
