package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"prophet-trader/config"
	"prophet-trader/controllers"
	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/services"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

func executionModeEnabled(mode string) bool {
	mode = strings.ToLower(strings.TrimSpace(mode))
	return mode == "paper" || mode == "enabled"
}

func shouldStartHTTPServer(executionEnabled bool) bool {
	return executionEnabled
}

func main() {
	// Load configuration
	if err := config.Load(); err != nil {
		log.Fatal("Failed to load configuration:", err)
	}

	cfg := config.AppConfig

	// Initialize logger
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})

	if cfg.EnableLogging {
		level, _ := logrus.ParseLevel(cfg.LogLevel)
		logger.SetLevel(level)
	}

	logger.Info("Starting Prophet Trader Bot...")
	executionEnabled := executionModeEnabled(cfg.ExecutionMode)
	if !executionEnabled {
		logger.Warn("Execution mode is inert; broker trading service will not be initialized")
		return
	}

	// Validate required configuration
	if executionEnabled && (cfg.AlpacaAPIKey == "" || cfg.AlpacaSecretKey == "") {
		logger.Fatal("Alpaca API credentials not configured. Please set ALPACA_API_KEY and ALPACA_SECRET_KEY")
	}

	// Initialize services
	logger.Info("Initializing services...")

	// Create trading service only for paper or explicitly enabled execution.
	var tradingService *services.AlpacaTradingService
	if executionEnabled {
		var err error
		tradingService, err = services.NewAlpacaTradingService(
			cfg.AlpacaAPIKey,
			cfg.AlpacaSecretKey,
			cfg.AlpacaBaseURL,
			cfg.AlpacaPaper,
		)
		if err != nil {
			logger.Warn("Failed to create trading service (will retry on requests):", err)
		}
	}

	// Inert startup must not initialize any broker-backed client.
	var dataService *services.AlpacaDataService
	if executionEnabled {
		dataService = services.NewAlpacaDataService(cfg.AlpacaAPIKey, cfg.AlpacaSecretKey)
	}

	var storageService *database.LocalStorage
	var err error
	if executionEnabled {
		storageService, err = database.NewLocalStorage(cfg.DatabasePath)
	}
	if err != nil {
		if executionEnabled {
			logger.Fatal("Failed to create storage service:", err)
		}
		logger.Warn("Inert storage unavailable; broker-backed persistence routes will remain unavailable:", err)
	}
	if tradingService != nil {
		tradingService.SetLocalOrderProvider(func(context.Context) ([]*interfaces.Order, error) {
			all, err := storageService.GetOrders("")
			if err != nil {
				return nil, err
			}
			// Risk reservations are scoped to this runtime's durable identity.
			// Never aggregate unverified sibling databases across accounts or tenants.
			pending := make([]*interfaces.Order, 0, len(all))
			for _, order := range all {
				if order == nil || order.Purpose != "entry" {
					continue
				}
				switch strings.ToLower(order.Status) {
				case "filled", "canceled", "cancelled", "rejected", "expired", "done_for_day", "replaced":
					continue
				default:
					pending = append(pending, order)
				}
			}
			return pending, nil
		})
		accountKey := os.Getenv("ALPACA_ACCOUNT_ID")
		accountHash := sha256.Sum256([]byte(accountKey))
		lockPath := filepath.Join(filepath.Dir(filepath.Dir(cfg.DatabasePath)), "account-"+hex.EncodeToString(accountHash[:])[:24]+".opening.lock")
		tradingService.SetOpeningReservationLock(lockPath)
	}

	// Create order controller
	orderController := controllers.NewOrderController(
		tradingService,
		dataService,
		storageService,
	)

	// Create news service and controller
	newsService := services.NewNewsService()
	newsController := controllers.NewNewsController(newsService)

	// Create economic feeds service and controller
	economicFeedsService := services.NewEconomicFeedsService()
	economicFeedsController := controllers.NewEconomicFeedsController(economicFeedsService)

	// Create Gemini service and intelligence controller
	geminiService := services.NewGeminiService(cfg.GeminiAPIKey)
	analysisService := services.NewTechnicalAnalysisService(dataService)
	stockAnalysisService := services.NewStockAnalysisService(dataService, newsService, geminiService)
	intelligenceController := controllers.NewIntelligenceController(newsService, geminiService, analysisService, stockAnalysisService, dataService)

	// Test account connection
	logger.Info("Testing Alpaca connection...")
	brokerReady := false
	if tradingService != nil {
		if account, err := orderController.GetAccount(); err != nil {
			logger.Warn("Failed to connect to Alpaca (trading will be unavailable):", err)
		} else {
			logger.WithFields(logrus.Fields{
				"cash":            account.Cash,
				"buying_power":    account.BuyingPower,
				"portfolio_value": account.PortfolioValue,
			}).Info("Successfully connected to Alpaca")
			brokerReady = true
		}
	} else {
		logger.Warn("Trading service unavailable - API credentials may be invalid")
	}

	orderController.SetExecutionBlocked(true)
	if tradingService != nil {
		tradingService.SetExecutionBlocked(true)
	}
	reconcileSkipped := 1
	managedSkipped := 1
	if brokerReady {
		reconcileCtx, reconcileCancel := context.WithTimeout(context.Background(), 30*time.Second)
		reconciled, skipped := orderController.ReconcileOpenOrders(reconcileCtx)
		reconcileCancel()
		reconcileSkipped = skipped
		logger.WithFields(logrus.Fields{
			"reconciled": reconciled,
			"skipped":    skipped,
		}).Info("Startup order reconciliation complete")
		if skipped > 0 {
			logger.Error("Trading execution remains blocked because persisted order state is unresolved")
		}
	} else {
		logger.Error("Trading execution remains blocked because the trading service is unavailable")
	}

	// Start background tasks
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Create position manager
	positionManager := services.NewPositionManager(tradingService, dataService, storageService)
	positionManager.SetExecutionBlocked(true)
	if brokerReady {
		managedCtx, managedCancel := context.WithTimeout(context.Background(), 30*time.Second)
		managedSkipped = positionManager.ReconcilePersistedPositions(managedCtx)
		managedCancel()
	}
	if executionEnabled && brokerReady && reconcileSkipped == 0 && managedSkipped == 0 {
		os.Setenv("OPENPROPHET_RECONCILIATION_COMPLETE", "true")
		orderController.SetExecutionBlocked(false)
		tradingService.SetExecutionBlocked(false)
		positionManager.SetExecutionBlocked(false)
	} else {
		logger.WithFields(logrus.Fields{"order_skipped": reconcileSkipped, "managed_skipped": managedSkipped}).Error("Trading execution remains blocked after startup reconciliation")
	}
	positionController := controllers.NewPositionManagementController(positionManager)

	// Create activity logger
	activityLogDir := os.Getenv("ACTIVITY_LOG_DIR")
	if activityLogDir == "" {
		activityLogDir = "./activity_logs"
	}
	activityLogger := services.NewActivityLogger(activityLogDir)
	activityController := controllers.NewActivityController(activityLogger)

	// Start trading session automatically only after an enabled broker connection.
	if executionEnabled && tradingService != nil {
		if account, err := orderController.GetAccount(); err == nil {
			activityLogger.StartSession(ctx, account.PortfolioValue)
			logger.Info("Activity logging session started")
		}
	}

	// Setup HTTP server
	router := setupRouter(orderController, brokerReady, positionManager, newsController, intelligenceController, positionController, activityController, economicFeedsController)

	// Start data cleanup routine
	if storageService != nil {
		go startDataCleanup(ctx, storageService, cfg.DataRetentionDays, logger)
	}

	// Start position monitor only after persisted order reconciliation clears the execution gate.
	if storageService != nil && !orderController.ExecutionBlocked() {
		go startPositionMonitor(ctx, orderController, storageService, logger)
		go positionManager.MonitorPositions(ctx)
	} else {
		logger.Error("Position monitoring disabled because trading execution is blocked")
	}

	// Setup graceful shutdown
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-shutdown
		logger.Info("Shutting down gracefully...")
		cancel()
		time.Sleep(2 * time.Second)
		os.Exit(0)
	}()

	// Start HTTP server
	logger.WithFields(logrus.Fields{"host": cfg.ServerHost, "port": cfg.ServerPort}).Info("Starting HTTP server...")
	if shouldStartHTTPServer(executionEnabled) {
		if err := router.Run(cfg.ServerHost + ":" + cfg.ServerPort); err != nil {
			logger.Fatal("Failed to start server:", err)
		}
	}
}

func setupRouter(orderController *controllers.OrderController, tradingReady bool, positionManager *services.PositionManager, newsController *controllers.NewsController, intelligenceController *controllers.IntelligenceController, positionController *controllers.PositionManagementController, activityController *controllers.ActivityController, economicFeedsController *controllers.EconomicFeedsController) *gin.Engine {
	router := gin.Default()
	if err := router.SetTrustedProxies(nil); err != nil {
		panic(fmt.Sprintf("failed to disable trusted proxies: %v", err))
	}
	expectedSandboxID := os.Getenv("OPENPROPHET_SANDBOX_ID")
	expectedAccountID := os.Getenv("OPENPROPHET_ACCOUNT_ID")
	expectedProcessNonce := os.Getenv("OPENPROPHET_PROCESS_NONCE")
	if expectedSandboxID == "" || expectedAccountID == "" || expectedProcessNonce == "" || os.Getenv("ALPACA_ACCOUNT_ID") == "" {
		router.Use(func(c *gin.Context) {
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "complete backend identity is required"})
		})
	} else {
		router.Use(func(c *gin.Context) {
			if c.GetHeader("X-OpenProphet-Sandbox-ID") != expectedSandboxID || c.GetHeader("X-OpenProphet-Account-ID") != expectedAccountID || c.GetHeader("X-OpenProphet-Process-Nonce") != expectedProcessNonce {
				c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "backend identity mismatch"})
				return
			}
			c.Next()
		})
	}

	// Enable CORS
	router.Use(func(c *gin.Context) {
		if isAllowedOrigin(c.GetHeader("Origin"), config.AppConfig.AllowedOrigins) {
			c.Writer.Header().Set("Access-Control-Allow-Origin", c.GetHeader("Origin"))
			c.Writer.Header().Set("Vary", "Origin")
		}
		c.Writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-OpenProphet-Sandbox-ID, X-OpenProphet-Account-ID, X-OpenProphet-Process-Nonce")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})

	// Health check
	router.GET("/health", func(c *gin.Context) {
		brokerAvailable := tradingReady
		if brokerAvailable {
			if _, err := orderController.GetAccount(); err != nil {
				brokerAvailable = false
			}
		}
		reconciliationComplete := os.Getenv("OPENPROPHET_RECONCILIATION_COMPLETE") == "true"
		identityComplete := os.Getenv("OPENPROPHET_SANDBOX_ID") != "" && os.Getenv("OPENPROPHET_ACCOUNT_ID") != "" && os.Getenv("ALPACA_ACCOUNT_ID") != "" && os.Getenv("OPENPROPHET_PROCESS_NONCE") != ""
		ready := brokerAvailable && identityComplete && reconciliationComplete && !orderController.ExecutionBlocked() && !positionManager.ExecutionBlocked()
		status := "healthy"
		httpStatus := 200
		if !ready {
			status = "degraded"
			httpStatus = 503
		}
		c.JSON(httpStatus, gin.H{
			"status":                  status,
			"ready":                   ready,
			"execution_ready":         ready,
			"sandbox_id":              os.Getenv("OPENPROPHET_SANDBOX_ID"),
			"account_id":              os.Getenv("OPENPROPHET_ACCOUNT_ID"),
			"broker_account_id":       os.Getenv("ALPACA_ACCOUNT_ID"),
			"paper":                   config.AppConfig.AlpacaPaper,
			"reconciliation_complete": os.Getenv("OPENPROPHET_RECONCILIATION_COMPLETE") == "true",
			"process_nonce":           os.Getenv("OPENPROPHET_PROCESS_NONCE"),
		})
	})

	// Trading endpoints
	api := router.Group("/api/v1")
	api.Use(func(c *gin.Context) {
		host, _, splitErr := net.SplitHostPort(c.Request.RemoteAddr)
		if splitErr != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
			c.AbortWithStatusJSON(403, gin.H{"error": "trading API is internal-only"})
			return
		}
		if config.AppConfig.AuthToken == "" {
			c.AbortWithStatusJSON(503, gin.H{"error": "trading API authentication is not configured"})
			return
		}
		if c.GetHeader("Authorization") == "Bearer "+config.AppConfig.AuthToken {
			expected := map[string]string{
				"X-OpenProphet-Sandbox-ID":    os.Getenv("OPENPROPHET_SANDBOX_ID"),
				"X-OpenProphet-Account-ID":    os.Getenv("OPENPROPHET_ACCOUNT_ID"),
				"X-OpenProphet-Process-Nonce": os.Getenv("OPENPROPHET_PROCESS_NONCE"),
			}
			for header, value := range expected {
				if value == "" || c.GetHeader(header) != value {
					c.AbortWithStatusJSON(403, gin.H{"error": "trading backend identity mismatch"})
					return
				}
			}
			if c.Request.Method == http.MethodDelete && (strings.HasPrefix(c.Request.URL.Path, "/api/v1/orders/") || strings.HasPrefix(c.Request.URL.Path, "/api/v1/positions/managed/")) {
				if config.AppConfig.OperatorToken == "" || c.GetHeader("X-OpenProphet-Operator-Token") != config.AppConfig.OperatorToken {
					c.AbortWithStatusJSON(403, gin.H{"error": "operator authorization is required for cancellation"})
					return
				}
			}
			c.Next()
			return
		}
		c.AbortWithStatus(401)
	})
	{
		// Order endpoints
		api.POST("/orders/buy", orderController.HandleBuy)
		api.POST("/orders/sell", orderController.HandleSell)
		api.DELETE("/orders/:id", orderController.HandleCancelOrder)
		api.GET("/orders", orderController.HandleGetOrders)
		api.GET("/clock", orderController.HandleGetMarketClock)

		// Position and account endpoints
		api.GET("/positions", orderController.HandleGetPositions)
		api.GET("/account", orderController.HandleGetAccount)

		// Market data endpoints
		api.GET("/market/quote/:symbol", orderController.HandleGetQuote)
		api.GET("/market/bar/:symbol", orderController.HandleGetBar)
		api.GET("/market/bars/:symbol", orderController.HandleGetBars)

		// Options trading endpoints
		api.POST("/options/order", orderController.PlaceOptionsOrder)
		api.GET("/options/positions", orderController.ListOptionsPositions)
		api.GET("/options/position/:symbol", orderController.GetOptionsPosition)
		api.GET("/options/chain/:symbol", orderController.GetOptionsChain)

		// News endpoints
		api.GET("/news", newsController.HandleGetNews)
		api.GET("/news/topic/:topic", newsController.HandleGetNewsByTopic)
		api.GET("/news/search", newsController.HandleSearchNews)
		api.GET("/news/market", newsController.HandleGetMarketNews)

		// MarketWatch endpoints
		api.GET("/news/marketwatch/topstories", newsController.HandleGetMarketWatchTopStories)
		api.GET("/news/marketwatch/realtime", newsController.HandleGetMarketWatchRealtimeHeadlines)
		api.GET("/news/marketwatch/bulletins", newsController.HandleGetMarketWatchBulletins)
		api.GET("/news/marketwatch/marketpulse", newsController.HandleGetMarketWatchMarketPulse)
		api.GET("/news/marketwatch/all", newsController.HandleGetAllMarketWatchNews)

		// Intelligence endpoints (AI-powered)
		api.POST("/intelligence/cleaned-news", intelligenceController.HandleGetCleanedNews)
		api.GET("/intelligence/quick-market", intelligenceController.HandleGetQuickMarketIntelligence)
		api.GET("/intelligence/analyze/:symbol", intelligenceController.HandleAnalyzeStock)
		api.POST("/intelligence/analyze-multiple", intelligenceController.HandleAnalyzeMultipleStocks)

		// Position management endpoints
		api.POST("/positions/managed", positionController.HandlePlaceManagedPosition)
		api.GET("/positions/managed", positionController.HandleListManagedPositions)
		api.GET("/positions/managed/:id", positionController.HandleGetManagedPosition)
		api.DELETE("/positions/managed/:id", positionController.HandleCloseManagedPosition)

		// Activity logging endpoints
		// Economic intelligence feeds (free, no API key required)
		api.GET("/feeds/treasury", economicFeedsController.HandleGetTreasury)
		api.GET("/feeds/gdelt", economicFeedsController.HandleGetGDELT)
		api.GET("/feeds/bls", economicFeedsController.HandleGetBLS)
		api.GET("/feeds/yfinance", economicFeedsController.HandleGetYFinance)
		api.GET("/feeds/usaspending", economicFeedsController.HandleGetUSASpending)
		api.GET("/feeds/comtrade", economicFeedsController.HandleGetComtrade)

		api.GET("/activity/current", activityController.HandleGetCurrentActivity)
		api.GET("/activity/:date", activityController.HandleGetActivityByDate)
		api.GET("/activity", activityController.HandleListActivityLogs)
		api.POST("/activity/session/start", activityController.HandleStartSession)
		api.POST("/activity/session/end", activityController.HandleEndSession)
		api.POST("/activity/log", activityController.HandleLogActivity)
	}

	// Serve dashboard
	router.Static("/dashboard", "./web")

	return router
}

func isAllowedOrigin(origin, allowedOrigins string) bool {
	if origin == "" {
		return false
	}

	if allowedOrigins != "" {
		for _, allowedOrigin := range strings.Split(allowedOrigins, ",") {
			if origin == strings.TrimSpace(allowedOrigin) {
				return true
			}
		}
		return false
	}

	parsedOrigin, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return parsedOrigin.Scheme == "http" && (parsedOrigin.Hostname() == "localhost" || parsedOrigin.Hostname() == "127.0.0.1")
}

// Background task to clean up old data
func startDataCleanup(ctx context.Context, storage interfaces.StorageService, retentionDays int, logger *logrus.Logger) {
	ticker := time.NewTicker(24 * time.Hour) // Run daily
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cutoff := time.Now().AddDate(0, 0, -retentionDays)
			logger.WithField("cutoff", cutoff).Info("Running data cleanup")

			if err := storage.CleanupOldData(cutoff); err != nil {
				logger.WithError(err).Error("Failed to cleanup old data")
			}
		}
	}
}

// Background task to monitor and save positions
func startPositionMonitor(ctx context.Context, orderController *controllers.OrderController, storage *database.LocalStorage, logger *logrus.Logger) {
	ticker := time.NewTicker(5 * time.Minute) // Check every 5 minutes
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Get current positions
			positions, err := orderController.GetPositions()
			if err != nil {
				logger.WithError(err).Error("Failed to get positions")
				continue
			}

			// Save position snapshots
			for _, position := range positions {
				if err := storage.SavePosition(position); err != nil {
					logger.WithError(err).Error("Failed to save position snapshot")
				}
			}

			// Get and save account snapshot
			if account, err := orderController.GetAccount(); err == nil {
				if err := storage.SaveAccountSnapshot(account); err != nil {
					logger.WithError(err).Error("Failed to save account snapshot")
				}
			}

			logger.WithField("positions", len(positions)).Debug("Position monitor update complete")
		}
	}
}
