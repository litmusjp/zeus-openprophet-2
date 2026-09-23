package controllers

import (
	"net/http"
	"prophet-trader/services"
	"strconv"

	"github.com/gin-gonic/gin"
)

// NewsController handles news-related HTTP requests
type NewsController struct {
	newsService *services.NewsService
}

// NewNewsController creates a new news controller
func NewNewsController(newsService *services.NewsService) *NewsController {
	return &NewsController{
		newsService: newsService,
	}
}

// HandleGetNews fetches the latest news
// GET /api/v1/news?limit=10
func (nc *NewsController) HandleGetNews(c *gin.Context) {
	limitStr := c.DefaultQuery("limit", "20")
	limit, err := strconv.Atoi(limitStr)
	if err != nil {
		limit = 20
	}

	news, err := nc.newsService.GetLatestNews(limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to fetch news",
			"details": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"count": len(news),
		"news":  news,
	})
}

// HandleGetNewsByTopic fetches news for a specific topic
// GET /api/v1/news/topic/:topic?compact=true
// Topics: WORLD, NATION, BUSINESS, TECHNOLOGY, ENTERTAINMENT, SPORTS, SCIENCE, HEALTH
func (nc *NewsController) HandleGetNewsByTopic(c *gin.Context) {
	topic := c.Param("topic")
	compact := c.DefaultQuery("compact", "false") == "true"

	news, err := nc.newsService.GetGoogleNewsByTopic(topic)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to fetch topic news",
			"details": err.Error(),
		})
		return
	}

	// Apply limit if needed to prevent huge responses
	maxItems := 50
	if len(news) > maxItems {
		news = news[:maxItems]
	}

	if compact {
		compactNews := make([]services.NewsItemCompact, len(news))
		for i, item := range news {
			compactNews[i] = item.ToCompact()
		}
		c.JSON(http.StatusOK, gin.H{
			"topic": topic,
			"count": len(compactNews),
			"news":  compactNews,
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"topic": topic,
		"count": len(news),
		"news":  news,
	})
}

// HandleSearchNews searches for news by query
// GET /api/v1/news/search?q=Tesla&limit=10
func (nc *NewsController) HandleSearchNews(c *gin.Context) {
	query := c.Query("q")
	if query == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Query parameter 'q' is required",
		})
		return
	}

	limitStr := c.DefaultQuery("limit", "20")
	limit, err := strconv.Atoi(limitStr)
	if err != nil {
		limit = 20
	}

	news, err := nc.newsService.GetGoogleNewsSearch(query)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to search news",
			"details": err.Error(),
		})
		return
	}

	// Apply limit
	if limit > 0 && limit < len(news) {
		news = news[:limit]
	}

	c.JSON(http.StatusOK, gin.H{
		"query": query,
		"count": len(news),
		"news":  news,
	})
}

// HandleGetMarketNews fetches market-related news
// GET /api/v1/news/market?symbols=TSLA,NVDA,AAPL
func (nc *NewsController) HandleGetMarketNews(c *gin.Context) {
	symbols := c.Query("symbols")
	normalizedSymbols := services.NormalizeNewsSymbols(symbols)
	if len(normalizedSymbols) == 0 {
		// Default to general market news
		news, err := nc.newsService.GetGoogleNewsByTopic("BUSINESS")
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Failed to fetch market news",
				"details": err.Error(),
			})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"count": len(news),
			"news":  news,
		})
		return
	}

	// Search for specific symbols
	news, normalizedSymbols, err := nc.newsService.GetGoogleNewsSearchBySymbols(symbols)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to fetch symbol news",
			"details": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"symbols": normalizedSymbols,
		"count":   len(news),
		"news":    news,
	})
}

// HandleGetMarketWatchTopStories fetches MarketWatch top stories
// GET /api/v1/news/marketwatch/topstories
func (nc *NewsController) HandleGetMarketWatchTopStories(c *gin.Context) {
	news, err := nc.newsService.GetMarketWatchTopStories()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to fetch MarketWatch top stories",
			"details": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"source": "MarketWatch Top Stories",
		"count":  len(news),
		"news":   news,
	})
}

// HandleGetMarketWatchRealtimeHeadlines fetches MarketWatch realtime headlines
// GET /api/v1/news/marketwatch/realtime
func (nc *NewsController) HandleGetMarketWatchRealtimeHeadlines(c *gin.Context) {
	news, err := nc.newsService.GetMarketWatchRealtimeHeadlines()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to fetch MarketWatch realtime headlines",
			"details": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"source": "MarketWatch Realtime Headlines",
		"count":  len(news),
		"news":   news,
	})
}

// HandleGetMarketWatchBulletins fetches MarketWatch breaking news bulletins
// GET /api/v1/news/marketwatch/bulletins
func (nc *NewsController) HandleGetMarketWatchBulletins(c *gin.Context) {
	news, err := nc.newsService.GetMarketWatchBulletins()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to fetch MarketWatch bulletins",
			"details": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"source": "MarketWatch Breaking News Bulletins",
		"count":  len(news),
		"news":   news,
	})
}

// HandleGetMarketWatchMarketPulse fetches MarketWatch market pulse
// GET /api/v1/news/marketwatch/marketpulse
func (nc *NewsController) HandleGetMarketWatchMarketPulse(c *gin.Context) {
	news, err := nc.newsService.GetMarketWatchMarketPulse()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to fetch MarketWatch market pulse",
			"details": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"source": "MarketWatch Market Pulse",
		"count":  len(news),
		"news":   news,
	})
}

// HandleGetAllMarketWatchNews fetches all MarketWatch news feeds aggregated
// GET /api/v1/news/marketwatch/all
func (nc *NewsController) HandleGetAllMarketWatchNews(c *gin.Context) {
	news, err := nc.newsService.GetAllMarketWatchNews()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to fetch all MarketWatch news",
			"details": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"source": "MarketWatch All Feeds",
		"count":  len(news),
		"news":   news,
	})
}
