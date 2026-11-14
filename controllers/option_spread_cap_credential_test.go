package controllers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"prophet-trader/services"
)

// Only the server-only credential changes the cap: not the API bearer token, not the operator token that agent
// children inherit, and never when the backend was started without a credential.
func TestOptionSpreadCapChangeNeedsTheServerOnlyCredential(t *testing.T) {
	gin.SetMode(gin.TestMode)
	stub := &spreadCapStub{service: &services.AlpacaTradingService{}}
	controller := NewOrderController(stub, nil, nil)
	router := gin.New()
	router.PUT("/risk/option-spread-cap", controller.HandlePutOptionSpreadCap)
	put := func(headers map[string]string) int {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPut, "/risk/option-spread-cap", strings.NewReader(`{"pct":10}`))
		for k, v := range headers {
			request.Header.Set(k, v)
		}
		router.ServeHTTP(response, request)
		return response.Code
	}
	t.Setenv("OPENPROPHET_CAP_CONTROL_TOKEN", "cap-token")
	t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "operator-token")
	t.Setenv("TRADING_BOT_TOKEN", "api-token")
	for name, headers := range map[string]map[string]string{
		"no_header":              {},
		"wrong_token":            {"X-OpenProphet-Cap-Control-Token": "nope"},
		"operator_token":         {"X-OpenProphet-Operator-Token": "operator-token"},
		"operator_in_cap_header": {"X-OpenProphet-Cap-Control-Token": "operator-token"},
		"api_bearer":             {"Authorization": "Bearer api-token"},
		"blank_header":           {"X-OpenProphet-Cap-Control-Token": " "},
	} {
		if code := put(headers); code != 403 {
			t.Fatalf("%s was not refused: %d", name, code)
		}
	}
	if _, configured, _ := stub.OptionSpreadCapPct(); configured {
		t.Fatal("a refused request changed the cap")
	}
	if code := put(map[string]string{"X-OpenProphet-Cap-Control-Token": "cap-token"}); code != 200 {
		t.Fatalf("the server credential was refused: %d", code)
	}
	t.Setenv("OPENPROPHET_CAP_CONTROL_TOKEN", "")
	if code := put(map[string]string{"X-OpenProphet-Cap-Control-Token": ""}); code != 403 {
		t.Fatalf("a backend without a credential accepted a change: %d", code)
	}
}
