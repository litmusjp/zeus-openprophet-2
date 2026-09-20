package config

import "testing"

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
