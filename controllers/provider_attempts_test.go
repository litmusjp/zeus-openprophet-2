package controllers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestHandleGetProviderAttemptsIsReadOnlyJSON(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/v1/diagnostics/provider-attempts", HandleGetProviderAttempts)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/diagnostics/provider-attempts", nil))
	if w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if _, ok := body["provider_attempts"].(float64); !ok {
		t.Fatalf("provider_attempts missing or not a number: %v", body)
	}
	// Mutating methods are not routed.
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/v1/diagnostics/provider-attempts", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("POST should not be routed, got %d", w.Code)
	}
}
