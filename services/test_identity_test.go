package services

import "os"

func init() {
	os.Setenv("ALPACA_ACCOUNT_ID", "test-broker-account")
	os.Setenv("ALPACA_PAPER", "true")
	os.Setenv("OPENPROPHET_TENANT_ID", "test-tenant")
	os.Setenv("OPENPROPHET_SANDBOX_ID", "test-sandbox")
}
