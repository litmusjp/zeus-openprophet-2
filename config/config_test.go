package config

import "testing"

func TestDefaultLoadUsesPaperModeAndCredentials(t *testing.T) {
	t.Setenv("OPENPROPHET_EXECUTION_MODE", "")
	t.Setenv("ALPACA_API_KEY", "paper-api-key")
	t.Setenv("ALPACA_SECRET_KEY", "paper-secret-key")
	t.Setenv("ALPACA_PAPER", "")

	if err := Load(); err != nil {
		t.Fatal(err)
	}
	if AppConfig.ExecutionMode != "paper" {
		t.Fatalf("default execution mode = %q, want paper", AppConfig.ExecutionMode)
	}
	if AppConfig.AlpacaAPIKey != "paper-api-key" || AppConfig.AlpacaSecretKey != "paper-secret-key" {
		t.Fatalf("paper credentials were not loaded: %+v", AppConfig)
	}
	if !AppConfig.AlpacaPaper || AppConfig.AlpacaBaseURL != "https://paper-api.alpaca.markets" {
		t.Fatalf("paper defaults were not applied: %+v", AppConfig)
	}
}

func TestPaperLoadRejectsLiveOrCustomBrokerSettings(t *testing.T) {
	tests := []struct {
		name    string
		paper   string
		baseURL string
	}{
		{name: "live flag", paper: "false", baseURL: "https://paper-api.alpaca.markets"},
		{name: "live endpoint", paper: "true", baseURL: "https://api.alpaca.markets"},
		{name: "custom endpoint", paper: "true", baseURL: "https://broker.example.test"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("OPENPROPHET_EXECUTION_MODE", "paper")
			t.Setenv("ALPACA_PAPER", tt.paper)
			t.Setenv("ALPACA_BASE_URL", tt.baseURL)
			if err := Load(); err == nil {
				t.Fatalf("Load() accepted paper safety violation: paper=%q baseURL=%q", tt.paper, tt.baseURL)
			}
		})
	}
}

func TestInertLoadDoesNotImportBrokerCredentials(t *testing.T) {
	t.Setenv("OPENPROPHET_EXECUTION_MODE", "inert")
	t.Setenv("ALPACA_API_KEY", "must-not-be-imported")
	t.Setenv("ALPACA_SECRET_KEY", "must-not-be-imported")
	t.Setenv("ALPACA_PAPER", "true")

	if err := Load(); err != nil {
		t.Fatal(err)
	}
	if AppConfig.AlpacaAPIKey != "" || AppConfig.AlpacaSecretKey != "" {
		t.Fatalf("inert config imported broker credentials: api=%q secret-present=%t", AppConfig.AlpacaAPIKey, AppConfig.AlpacaSecretKey != "")
	}
}

func TestInertLoadDoesNotReadBrokerSettings(t *testing.T) {
	t.Setenv("OPENPROPHET_EXECUTION_MODE", "inert")
	t.Setenv("ALPACA_BASE_URL", "https://evil.invalid")
	t.Setenv("PORT", "9999")
	t.Setenv("TRADING_BOT_TOKEN", "must-not-be-imported")
	t.Setenv("TRADING_BOT_OPERATOR_TOKEN", "must-not-be-imported")
	t.Setenv("OPENPROPHET_TENANT_ID", "must-not-be-imported")
	t.Setenv("OPENPROPHET_SANDBOX_ID", "must-not-be-imported")

	if err := Load(); err != nil {
		t.Fatal(err)
	}
	if AppConfig.AlpacaBaseURL != "" || AppConfig.ServerPort != "" || AppConfig.AuthToken != "" || AppConfig.OperatorToken != "" || AppConfig.TenantID != "" {
		t.Fatalf("inert config imported broker/runtime settings: %+v", AppConfig)
	}
}
