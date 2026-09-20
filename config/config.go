package config

import (
	"fmt"
	"os"
	"strings"

	"github.com/joho/godotenv"
)

type Config struct {
	AlpacaAPIKey      string
	AlpacaSecretKey   string
	AlpacaBaseURL     string
	AlpacaPaper       bool
	GeminiAPIKey      string
	DatabasePath      string
	ServerPort        string
	ServerHost        string
	AuthToken         string
	OperatorToken     string
	TenantID          string
	AllowedOrigins    string
	EnableLogging     bool
	LogLevel          string
	DataRetentionDays int
	ExecutionMode     string
}

var AppConfig *Config

func Load() error {
	executionMode := strings.ToLower(strings.TrimSpace(getEnvOrDefault("OPENPROPHET_EXECUTION_MODE", "inert")))
	if executionMode != "enabled" && executionMode != "inert" {
		return fmt.Errorf("OPENPROPHET_EXECUTION_MODE must be inert or enabled")
	}
	// Inert startup must not import broker credentials from a dotenv file.
	if executionMode == "enabled" {
		_ = godotenv.Load()
	} else {
		AppConfig = &Config{ExecutionMode: "inert"}
		return nil
	}
	apiKey, secretKey := "", ""
	if executionMode == "enabled" {
		apiKey = os.Getenv("ALPACA_API_KEY")
		secretKey = os.Getenv("ALPACA_SECRET_KEY")
	}
	paperValue, paperSet := os.LookupEnv("ALPACA_PAPER")
	if executionMode == "enabled" && (!paperSet || (paperValue != "true" && paperValue != "false")) {
		return fmt.Errorf("ALPACA_PAPER must be explicitly true or false when execution is enabled")
	}

	AppConfig = &Config{
		AlpacaAPIKey:      apiKey,
		AlpacaSecretKey:   secretKey,
		AlpacaBaseURL:     getEnvOrDefault("ALPACA_BASE_URL", "https://paper-api.alpaca.markets"),
		AlpacaPaper:       paperValue == "true",
		GeminiAPIKey:      os.Getenv("GEMINI_API_KEY"),
		DatabasePath:      getEnvOrDefault("DATABASE_PATH", "./data/prophet_trader.db"),
		ServerPort:        getEnvOrDefault("PORT", getEnvOrDefault("SERVER_PORT", "4534")),
		ServerHost:        getEnvOrDefault("SERVER_HOST", "127.0.0.1"),
		AuthToken:         getEnvOrDefault("TRADING_BOT_TOKEN", ""),
		OperatorToken:     getEnvOrDefault("TRADING_BOT_OPERATOR_TOKEN", ""),
		AllowedOrigins:    getEnvOrDefault("CORS_ALLOWED_ORIGINS", ""),
		EnableLogging:     getEnvOrDefault("ENABLE_LOGGING", "true") == "true",
		LogLevel:          getEnvOrDefault("LOG_LEVEL", "info"),
		DataRetentionDays: 90,
		ExecutionMode:     executionMode,
		TenantID:          strings.TrimSpace(os.Getenv("OPENPROPHET_TENANT_ID")),
	}

	return nil
}

func getEnvOrDefault(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
