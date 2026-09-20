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

const alpacaPaperBaseURL = "https://paper-api.alpaca.markets"

func Load() error {
	executionMode := strings.ToLower(strings.TrimSpace(getEnvOrDefault("OPENPROPHET_EXECUTION_MODE", "paper")))
	if executionMode != "enabled" && executionMode != "paper" && executionMode != "inert" {
		return fmt.Errorf("OPENPROPHET_EXECUTION_MODE must be inert, paper, or enabled")
	}
	// Inert startup must not import broker credentials from a dotenv file.
	if executionMode != "inert" {
		_ = godotenv.Load()
	} else {
		AppConfig = &Config{ExecutionMode: "inert"}
		return nil
	}
	apiKey, secretKey := "", ""
	apiKey = os.Getenv("ALPACA_API_KEY")
	secretKey = os.Getenv("ALPACA_SECRET_KEY")
	paperValue, paperSet := os.LookupEnv("ALPACA_PAPER")
	if executionMode == "enabled" && (!paperSet || (paperValue != "true" && paperValue != "false")) {
		return fmt.Errorf("ALPACA_PAPER must be explicitly true or false when execution is enabled")
	}
	if executionMode == "paper" {
		if !paperSet || paperValue == "" {
			paperValue = "true"
		}
		if paperValue != "true" {
			return fmt.Errorf("ALPACA_PAPER must be true in paper execution mode")
		}
	}
	baseURL := getEnvOrDefault("ALPACA_BASE_URL", alpacaPaperBaseURL)
	if executionMode == "paper" && strings.TrimRight(baseURL, "/") != alpacaPaperBaseURL {
		return fmt.Errorf("ALPACA_BASE_URL must be the official Alpaca paper endpoint in paper execution mode")
	}

	AppConfig = &Config{
		AlpacaAPIKey:      apiKey,
		AlpacaSecretKey:   secretKey,
		AlpacaBaseURL:     baseURL,
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
