package controllers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"prophet-trader/interfaces"
	"prophet-trader/services"
)

type spreadCapStub struct {
	interfaces.TradingService
	service *services.AlpacaTradingService
}

func (s *spreadCapStub) SetOptionSpreadCapPct(pct float64) error {
	return s.service.SetOptionSpreadCapPct(pct)
}
func (s *spreadCapStub) OptionSpreadCapState() (float64, bool, bool, int64) {
	return s.service.OptionSpreadCapState()
}

// OptionSpreadCapPct is a test convenience (the controller reads the state in one call).
func (s *spreadCapStub) OptionSpreadCapPct() (float64, bool, bool) {
	return s.service.OptionSpreadCapPct()
}

func TestOptionSpreadCapEndpointsReportAndApplyTheCap(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("OPENPROPHET_CAP_CONTROL_TOKEN", "cap-token")
	stub := &spreadCapStub{service: &services.AlpacaTradingService{}}
	controller := NewOrderController(stub, nil, nil)
	router := gin.New()
	router.GET("/risk/option-spread-cap", controller.HandleGetOptionSpreadCap)
	router.PUT("/risk/option-spread-cap", controller.HandlePutOptionSpreadCap)
	call := func(method, body string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(method, "/risk/option-spread-cap", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		if method == http.MethodPut {
			request.Header.Set("X-OpenProphet-Cap-Control-Token", "cap-token")
		}
		router.ServeHTTP(response, request)
		return response
	}
	if r := call(http.MethodGet, ""); r.Code != 200 || !strings.Contains(r.Body.String(), `"configured":false`) {
		t.Fatalf("unconfigured state not reported: %d %s", r.Code, r.Body.String())
	}
	if r := call(http.MethodPut, `{"pct":10}`); r.Code != 200 || !strings.Contains(r.Body.String(), `"effective_pct":10`) || !strings.Contains(r.Body.String(), `"configured":true`) {
		t.Fatalf("cap not applied: %d %s", r.Code, r.Body.String())
	}
	if r := call(http.MethodGet, ""); !strings.Contains(r.Body.String(), `"effective_pct":10`) {
		t.Fatalf("effective cap not reported: %s", r.Body.String())
	}
	for _, body := range []string{`{}`, `{"pct":"x"}`, `{"pct":1}`, `{"pct":30}`, `not json`} {
		if r := call(http.MethodPut, body); r.Code != 400 {
			t.Fatalf("bad body %q accepted: %d %s", body, r.Code, r.Body.String())
		}
	}
	if r := call(http.MethodGet, ""); !strings.Contains(r.Body.String(), `"effective_pct":10`) {
		t.Fatalf("a rejected change altered the cap: %s", r.Body.String())
	}
}

func TestOptionSpreadCapEndpointsUnavailableWithoutSupport(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("OPENPROPHET_CAP_CONTROL_TOKEN", "cap-token")
	controller := NewOrderController(&standaloneOnlyService{}, nil, nil)
	router := gin.New()
	router.GET("/risk/option-spread-cap", controller.HandleGetOptionSpreadCap)
	router.PUT("/risk/option-spread-cap", controller.HandlePutOptionSpreadCap)
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(method, "/risk/option-spread-cap", strings.NewReader(`{"pct":10}`))
		request.Header.Set("X-OpenProphet-Cap-Control-Token", "cap-token")
		router.ServeHTTP(response, request)
		if response.Code != 503 {
			t.Fatalf("%s without support returned %d", method, response.Code)
		}
	}
}
