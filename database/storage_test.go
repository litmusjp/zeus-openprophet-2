package database

import (
	"path/filepath"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"reflect"
	"testing"
	"time"
)

func TestSaveOrderUpsertsByClientOrderID(t *testing.T) {
	storage, err := NewLocalStorage(filepath.Join(t.TempDir(), "orders.db"))
	if err != nil {
		t.Fatalf("NewLocalStorage() error = %v", err)
	}
	defer storage.Close()

	order := &interfaces.Order{
		ClientOrderID: "op-test-order", Symbol: "AAPL", Qty: 1, Side: "buy", Type: "market", TimeInForce: "day", Status: "pending", SubmittedAt: time.Now(),
	}
	if err := storage.SaveOrder(order); err != nil {
		t.Fatalf("SaveOrder(intent) error = %v", err)
	}
	order.ID = "broker-order-id"
	order.Status = "accepted"
	if err := storage.SaveOrder(order); err != nil {
		t.Fatalf("SaveOrder(result) error = %v", err)
	}
	var count int64
	if err := storage.db.Model(&models.DBOrder{}).Where("client_order_id = ?", order.ClientOrderID).Count(&count).Error; err != nil {
		t.Fatalf("count saved orders: %v", err)
	}
	if count != 1 {
		t.Fatalf("saved orders = %d, want 1", count)
	}
	saved, err := storage.GetOrder(order.ID)
	if err != nil {
		t.Fatalf("GetOrder() error = %v", err)
	}
	if saved.ClientOrderID != order.ClientOrderID || saved.Status != order.Status {
		t.Fatalf("saved order = %#v, want client_order_id %q and status %q", saved, order.ClientOrderID, order.Status)
	}
}

func TestSaveOrderRoundTripsAtomicOptionLegIdentity(t *testing.T) {
	storage, err := NewLocalStorage(filepath.Join(t.TempDir(), "legs.db"))
	if err != nil {
		t.Fatalf("NewLocalStorage() error = %v", err)
	}
	defer storage.Close()
	order := &interfaces.Order{ClientOrderID: "mleg-persist", Symbol: "TSLA251219P00400000", Underlying: "TSLA", Qty: 2, Side: "buy", Type: "limit", TimeInForce: "day", LimitPrice: func() *float64 { v := 1.25; return &v }(), Status: "pending", OptionLegs: []interfaces.OptionLeg{{Symbol: "TSLA251219P00400000", Side: "sell", RatioQty: 1, PositionIntent: "sell_to_open", Price: 2.1}, {Symbol: "TSLA251219P00390000", Side: "buy", RatioQty: 1, PositionIntent: "buy_to_open", Price: 0.85}}}
	if err := storage.SaveOrder(order); err != nil {
		t.Fatalf("SaveOrder() error = %v", err)
	}
	saved, err := storage.GetOrderByClientOrderID(order.ClientOrderID)
	if err != nil {
		t.Fatalf("GetOrderByClientOrderID() error = %v", err)
	}
	if len(saved.OptionLegs) != 2 || saved.OptionLegs[0] != order.OptionLegs[0] || saved.OptionLegs[1] != order.OptionLegs[1] {
		t.Fatalf("saved option legs = %#v, want %#v", saved.OptionLegs, order.OptionLegs)
	}
}

func TestSaveOrderUpdatesLegacyBrokerOrder(t *testing.T) {
	storage, err := NewLocalStorage(filepath.Join(t.TempDir(), "orders.db"))
	if err != nil {
		t.Fatalf("NewLocalStorage() error = %v", err)
	}
	defer storage.Close()
	order := &interfaces.Order{ID: "legacy-broker-order", Symbol: "AAPL", Status: "pending"}
	if err := storage.SaveOrder(order); err != nil {
		t.Fatalf("SaveOrder(initial) error = %v", err)
	}
	order.Status = "canceled"
	if err := storage.SaveOrder(order); err != nil {
		t.Fatalf("SaveOrder(update) error = %v", err)
	}
	var count int64
	if err := storage.db.Model(&models.DBOrder{}).Where("order_id = ?", order.ID).Count(&count).Error; err != nil {
		t.Fatalf("count saved orders: %v", err)
	}
	if count != 1 {
		t.Fatalf("saved orders = %d, want 1", count)
	}
}

func TestGetOrdersNeedingReconciliation(t *testing.T) {
	storage, err := NewLocalStorage(filepath.Join(t.TempDir(), "orders.db"))
	if err != nil {
		t.Fatalf("NewLocalStorage() error = %v", err)
	}
	defer storage.Close()
	orders := []*interfaces.Order{
		{ClientOrderID: "op-pending", Symbol: "AAPL", Status: "pending"},
		{ClientOrderID: "op-submit-failed", Symbol: "MSFT", Status: "submit_failed", SubmissionAttempted: true},
		{ClientOrderID: "op-filled", Symbol: "GOOG", Status: "filled"},
		{Symbol: "TSLA", Status: "pending"},
	}
	for _, order := range orders {
		if err := storage.SaveOrder(order); err != nil {
			t.Fatalf("SaveOrder(%q) error = %v", order.Symbol, err)
		}
	}
	got, err := storage.GetOrdersNeedingReconciliation()
	if err != nil {
		t.Fatalf("GetOrdersNeedingReconciliation() error = %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("GetOrdersNeedingReconciliation() returned %d orders, want 3", len(got))
	}
	clientOrderIDs := map[string]bool{}
	for _, order := range got {
		clientOrderIDs[order.ClientOrderID] = true
	}
	if !clientOrderIDs["op-pending"] || !clientOrderIDs["op-submit-failed"] {
		t.Fatalf("GetOrdersNeedingReconciliation() client order IDs = %v, want pending and submit_failed orders", clientOrderIDs)
	}
}

func TestSaveOrderRejectsStaleRevisionAndBrokerIdentity(t *testing.T) {
	storage, err := NewLocalStorage(filepath.Join(t.TempDir(), "orders.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	order := &interfaces.Order{ClientOrderID: "op-cas", ID: "broker-a", Symbol: "AAPL", Qty: 1, Side: "buy", Type: "market", TimeInForce: "day", Purpose: "entry", Status: "pending"}
	if err := storage.SaveOrder(order); err != nil {
		t.Fatal(err)
	}
	stale := *order
	order.Status = "accepted"
	if err := storage.SaveOrder(order); err != nil {
		t.Fatal(err)
	}
	stale.Status = "canceled"
	if err := storage.SaveOrder(&stale); err == nil {
		t.Fatal("stale order update should be rejected")
	}
	mismatched := *order
	mismatched.ID = "broker-b"
	if err := storage.SaveOrder(&mismatched); err == nil {
		t.Fatal("broker order identity replacement should be rejected")
	}
}

func TestSaveOrderPreservesSubmissionAttemptedMonotonically(t *testing.T) {
	storage, err := NewLocalStorage(filepath.Join(t.TempDir(), "orders.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()
	order := &interfaces.Order{ClientOrderID: "op-monotonic", Symbol: "AAPL", Qty: 1, Side: "buy", Type: "market", TimeInForce: "day", Purpose: "entry", Status: "submission_uncertain", SubmissionAttempted: true}
	if err := storage.SaveOrder(order); err != nil {
		t.Fatal(err)
	}
	order.SubmissionAttempted = false
	if err := storage.SaveOrder(order); err != nil {
		t.Fatal(err)
	}
	saved, err := storage.GetOrderByClientOrderID(order.ClientOrderID)
	if err != nil {
		t.Fatal(err)
	}
	if !saved.SubmissionAttempted {
		t.Fatal("submission_attempted was cleared by a later update")
	}
}

func TestMarkManagedSubmissionAttemptedIsAtomicAcrossProjections(t *testing.T) {
	storage, err := NewLocalStorage(filepath.Join(t.TempDir(), "managed-marker.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	order := &interfaces.Order{ClientOrderID: "managed-marker", Symbol: "AAPL", Qty: 1, Side: "buy", Type: "market", TimeInForce: "gtc", Status: "pending", Purpose: "entry", SubmittedAt: time.Now()}
	if err := storage.SaveOrder(order); err != nil {
		t.Fatal(err)
	}
	projection := &models.DBManagedOrder{DurableIdentity: storage.DurableIdentity(), PositionID: "position-1", Role: "entry", Purpose: "entry", ClientOrderID: order.ClientOrderID, Symbol: order.Symbol, Side: order.Side, OrderType: order.Type, TimeInForce: order.TimeInForce, RequestedQty: order.Qty, Lifecycle: "submitting"}
	if err := storage.SaveManagedOrder(projection); err != nil {
		t.Fatal(err)
	}
	if err := storage.MarkManagedSubmissionAttempted(order.ClientOrderID, "position-1", "entry"); err != nil {
		t.Fatal(err)
	}
	reopened, err := storage.GetOrderByClientOrderID(order.ClientOrderID)
	if err != nil || reopened == nil || !reopened.SubmissionAttempted {
		t.Fatalf("generic order after marker = %#v, err=%v; want attempted", reopened, err)
	}
	reopenedProjection, err := storage.GetManagedOrder(order.ClientOrderID)
	if err != nil || reopenedProjection == nil || !reopenedProjection.SubmissionAttempted {
		t.Fatalf("managed projection after marker = %#v, err=%v; want attempted", reopenedProjection, err)
	}
}

func TestMarkManagedSubmissionAttemptedFailsClosedAndRollsBack(t *testing.T) {
	storage, err := NewLocalStorage(filepath.Join(t.TempDir(), "managed-marker-rollback.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	order := &interfaces.Order{ClientOrderID: "managed-marker-rollback", Symbol: "AAPL", Qty: 1, Side: "buy", Type: "market", TimeInForce: "gtc", Status: "pending", Purpose: "entry", SubmittedAt: time.Now()}
	if err := storage.SaveOrder(order); err != nil {
		t.Fatal(err)
	}
	projection := &models.DBManagedOrder{DurableIdentity: storage.DurableIdentity(), PositionID: "position-1", Role: "protection", Purpose: "protection", ClientOrderID: order.ClientOrderID, Symbol: order.Symbol, Side: "sell", OrderType: "stop", TimeInForce: "gtc", RequestedQty: order.Qty, Lifecycle: "submitting"}
	if err := storage.SaveManagedOrder(projection); err != nil {
		t.Fatal(err)
	}
	if err := storage.MarkManagedSubmissionAttempted(order.ClientOrderID, "position-1", "entry"); err == nil {
		t.Fatal("MarkManagedSubmissionAttempted() succeeded for mismatched role")
	}
	reopened, err := storage.GetOrderByClientOrderID(order.ClientOrderID)
	if err != nil || reopened == nil || reopened.SubmissionAttempted {
		t.Fatalf("generic order after failed marker = %#v, err=%v; want unattempted", reopened, err)
	}
	reopenedProjection, err := storage.GetManagedOrder(order.ClientOrderID)
	if err != nil || reopenedProjection == nil || reopenedProjection.SubmissionAttempted {
		t.Fatalf("managed projection after failed marker = %#v, err=%v; want unattempted", reopenedProjection, err)
	}
}

func setManagedIdentity(t *testing.T, broker string) {
	t.Helper()
	t.Setenv("ALPACA_ACCOUNT_ID", broker)
	t.Setenv("ALPACA_PAPER", "true")
	t.Setenv("OPENPROPHET_TENANT_ID", "tenant-1")
	t.Setenv("OPENPROPHET_SANDBOX_ID", "sandbox-1")
}

func TestManagedOrderProjectionPersistsRoleIdentityAndWatermark(t *testing.T) {
	setManagedIdentity(t, "broker-account-1")
	storage, err := NewLocalStorage(filepath.Join(t.TempDir(), "managed-orders.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	order := &models.DBManagedOrder{
		PositionID:    "position-1",
		Role:          "protection",
		Purpose:       "protection",
		ClientOrderID: "client-protection-1",
		BrokerOrderID: "broker-protection-1",
		DurableIdentity: models.DurableIdentity{
			BrokerAccountID: "broker-account-1",
			PaperLive:       "paper",
			TenantID:        "tenant-1",
			SandboxID:       "sandbox-1",
		},
		Symbol:              "AAPL",
		Side:                "sell",
		AssetClass:          "us_equity",
		OrderType:           "limit",
		TimeInForce:         "day",
		RequestedQty:        5,
		FilledQty:           2,
		FillWatermark:       2,
		Revision:            1,
		Lifecycle:           "partially_filled",
		SubmissionAttempted: true,
	}
	if err := storage.SaveManagedOrder(order); err != nil {
		t.Fatal(err)
	}

	fresh, err := storage.GetManagedOrder(order.ClientOrderID)
	if err != nil {
		t.Fatal(err)
	}
	if fresh == nil || fresh.Role != "protection" || fresh.PositionID != "position-1" || fresh.FillWatermark != 2 || !fresh.SubmissionAttempted {
		t.Fatalf("managed order projection was not preserved: %#v", fresh)
	}
}

func TestManagedOrderProjectionRejectsIdentityReuse(t *testing.T) {
	setManagedIdentity(t, "broker-account-1")
	storage, err := NewLocalStorage(filepath.Join(t.TempDir(), "managed-orders-identity.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	order := &models.DBManagedOrder{
		PositionID:    "position-1",
		Role:          "entry",
		Purpose:       "entry",
		ClientOrderID: "client-entry-1",
		DurableIdentity: models.DurableIdentity{
			BrokerAccountID: "broker-account-1",
			PaperLive:       "paper",
			TenantID:        "tenant-1",
			SandboxID:       "sandbox-1",
		},
		Symbol:       "AAPL",
		Side:         "buy",
		RequestedQty: 1,
		Lifecycle:    "planned",
	}
	if err := storage.SaveManagedOrder(order); err != nil {
		t.Fatal(err)
	}

	mismatched := *order
	mismatched.BrokerAccountID = "broker-account-2"
	if err := storage.SaveManagedOrder(&mismatched); err == nil {
		t.Fatal("managed order identity reuse should be rejected")
	}
}

func TestManagedOrderProjectionRejectsBrokerIdentityRotation(t *testing.T) {
	setManagedIdentity(t, "broker-account-1")
	storage, err := NewLocalStorage(filepath.Join(t.TempDir(), "managed-orders-broker-id.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	order := &models.DBManagedOrder{
		PositionID:    "position-1",
		Role:          "entry",
		Purpose:       "entry",
		ClientOrderID: "client-entry-1",
		BrokerOrderID: "broker-order-1",
		DurableIdentity: models.DurableIdentity{
			BrokerAccountID: "broker-account-1",
			PaperLive:       "paper",
			TenantID:        "tenant-1",
			SandboxID:       "sandbox-1",
		},
		Symbol:       "AAPL",
		Side:         "buy",
		RequestedQty: 1,
		Lifecycle:    "accepted",
	}
	if err := storage.SaveManagedOrder(order); err != nil {
		t.Fatal(err)
	}

	rotated := *order
	rotated.BrokerOrderID = "broker-order-2"
	if err := storage.SaveManagedOrder(&rotated); err == nil {
		t.Fatal("managed order broker identity rotation should be rejected")
	}
}

func TestManagedOrderProjectionRejectsContractIdentityMutation(t *testing.T) {
	setManagedIdentity(t, "broker-account-1")
	storage, err := NewLocalStorage(filepath.Join(t.TempDir(), "managed-orders-contract.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	limit := 101.0
	order := &models.DBManagedOrder{
		PositionID: "position-1", Role: "protection", Purpose: "protection",
		ClientOrderID: "client-contract-1", Symbol: "AAPL", Side: "sell",
		AssetClass: "us_equity", OrderType: "limit", TimeInForce: "gtc",
		RequestedQty: 2, LimitPrice: &limit, Lifecycle: "planned",
		DurableIdentity: models.DurableIdentity{BrokerAccountID: "broker-account-1", PaperLive: "paper", TenantID: "tenant-1", SandboxID: "sandbox-1"},
	}
	if err := storage.SaveManagedOrder(order); err != nil {
		t.Fatal(err)
	}

	mutated := *order
	mutated.Purpose = "close"
	mutated.OrderType = "market"
	mutated.LimitPrice = nil
	if err := storage.SaveManagedOrder(&mutated); err == nil {
		t.Fatal("managed order contract mutation should be rejected")
	}
}

func TestManagedOrderProjectionRejectsNonEmptyContractConflictAfterRepair(t *testing.T) {
	setManagedIdentity(t, "broker-account-1")
	storage, err := NewLocalStorage(filepath.Join(t.TempDir(), "managed-orders-repair-conflict.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	order := &models.DBManagedOrder{
		PositionID: "position-1", Role: "entry", Purpose: "entry", ClientOrderID: "client-repair-conflict-1", BrokerOrderID: "broker-repair-conflict-1",
		Symbol: "AAPL", Side: "buy", AssetClass: "us_equity", Underlying: "AAPL", PositionIntent: "buy_to_open", OrderType: "limit", TimeInForce: "gtc", RequestedQty: 2,
		DurableIdentity: models.DurableIdentity{BrokerAccountID: "broker-account-1", PaperLive: "paper", TenantID: "tenant-1", SandboxID: "sandbox-1"},
	}
	if err := storage.SaveManagedOrder(order); err != nil {
		t.Fatal(err)
	}
	before, err := storage.GetManagedOrder(order.ClientOrderID)
	if err != nil {
		t.Fatal(err)
	}
	conflict := *order
	conflict.Revision = before.Revision
	conflict.AssetClass = "us_option"
	if err := storage.SaveManagedOrder(&conflict); err == nil {
		t.Fatal("non-empty immutable contract conflict should be rejected")
	}
	after, err := storage.GetManagedOrder(order.ClientOrderID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("persisted managed order changed after rejected conflict: before=%#v after=%#v", before, after)
	}
}

func TestManagedOrderProjectionRepairsLegacyAssetIntentAndPriceFields(t *testing.T) {
	setManagedIdentity(t, "broker-account-1")
	storage, err := NewLocalStorage(filepath.Join(t.TempDir(), "managed-orders-repair.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	price := 101.0
	stop := 99.0
	legacy := &models.DBManagedOrder{
		PositionID: "position-1", Role: "entry", Purpose: "entry", ClientOrderID: "client-repair-1", BrokerOrderID: "broker-repair-1",
		Symbol: "AAPL", RequestedQty: 2, Lifecycle: "accepted",
		DurableIdentity: models.DurableIdentity{BrokerAccountID: "broker-account-1", PaperLive: "paper", TenantID: "tenant-1", SandboxID: "sandbox-1"},
	}
	if err := storage.SaveManagedOrder(legacy); err != nil {
		t.Fatal(err)
	}

	repaired := *legacy
	repaired.Revision = 1
	repaired.Symbol = "AAPL"
	repaired.Side = "buy"
	repaired.AssetClass = "us_equity"
	repaired.Underlying = "AAPL"
	repaired.PositionIntent = "buy_to_open"
	repaired.OrderType = "limit"
	repaired.TimeInForce = "gtc"
	repaired.LimitPrice = &price
	repaired.StopPrice = &stop
	if err := storage.SaveManagedOrder(&repaired); err != nil {
		t.Fatal(err)
	}
	fresh, err := storage.GetManagedOrder(legacy.ClientOrderID)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Symbol != "AAPL" || fresh.Side != "buy" || fresh.AssetClass != "us_equity" || fresh.Underlying != "AAPL" ||
		fresh.PositionIntent != "buy_to_open" || fresh.OrderType != "limit" || fresh.TimeInForce != "gtc" ||
		fresh.Role != "entry" || fresh.Purpose != "entry" || fresh.RequestedQty != 2 ||
		fresh.LimitPrice == nil || *fresh.LimitPrice != price || fresh.StopPrice == nil || *fresh.StopPrice != stop {
		t.Fatalf("legacy repair fields were not repaired/preserved: %#v", fresh)
	}
}

func TestManagedOrderProjectionRejectsBlankOrChangedCoreImmutableFields(t *testing.T) {
	setManagedIdentity(t, "broker-account-1")
	tests := []struct {
		name   string
		mutate func(*models.DBManagedOrder)
	}{
		{"blank position ID", func(order *models.DBManagedOrder) { order.PositionID = "" }},
		{"changed position ID", func(order *models.DBManagedOrder) { order.PositionID = "position-2" }},
		{"blank role", func(order *models.DBManagedOrder) { order.Role = "" }},
		{"changed role", func(order *models.DBManagedOrder) { order.Role = "close" }},
		{"blank purpose", func(order *models.DBManagedOrder) { order.Purpose = "" }},
		{"changed purpose", func(order *models.DBManagedOrder) { order.Purpose = "close" }},
		{"blank symbol", func(order *models.DBManagedOrder) { order.Symbol = "" }},
		{"changed symbol", func(order *models.DBManagedOrder) { order.Symbol = "MSFT" }},
		{"zero quantity", func(order *models.DBManagedOrder) { order.RequestedQty = 0 }},
		{"changed quantity", func(order *models.DBManagedOrder) { order.RequestedQty = 3 }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			storage, err := NewLocalStorage(filepath.Join(t.TempDir(), "managed-orders-core-conflict.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer storage.Close()

			order := &models.DBManagedOrder{
				PositionID: "position-1", Role: "entry", Purpose: "entry", ClientOrderID: "client-core-" + tc.name, BrokerOrderID: "broker-core-" + tc.name,
				Symbol: "AAPL", Side: "buy", AssetClass: "us_equity", Underlying: "AAPL", PositionIntent: "buy_to_open", OrderType: "limit", TimeInForce: "gtc", RequestedQty: 2,
				DurableIdentity: models.DurableIdentity{BrokerAccountID: "broker-account-1", PaperLive: "paper", TenantID: "tenant-1", SandboxID: "sandbox-1"},
			}
			if err := storage.SaveManagedOrder(order); err != nil {
				t.Fatal(err)
			}
			before, err := storage.GetManagedOrder(order.ClientOrderID)
			if err != nil {
				t.Fatal(err)
			}
			conflict := *order
			conflict.Revision = before.Revision
			tc.mutate(&conflict)
			if err := storage.SaveManagedOrder(&conflict); err == nil {
				t.Fatal("core immutable field conflict should be rejected")
			}
			after, err := storage.GetManagedOrder(order.ClientOrderID)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, after) {
				t.Fatalf("persisted managed order changed after rejected conflict: before=%#v after=%#v", before, after)
			}
		})
	}
}

func TestManagedOrderProjectionKeepsCumulativeWatermarkAcrossSnapshots(t *testing.T) {
	setManagedIdentity(t, "broker-account-1")
	storage, err := NewLocalStorage(filepath.Join(t.TempDir(), "managed-orders-watermark.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	order := &models.DBManagedOrder{
		PositionID:    "position-1",
		Role:          "close",
		Purpose:       "close",
		ClientOrderID: "client-close-1",
		DurableIdentity: models.DurableIdentity{
			BrokerAccountID: "broker-account-1",
			PaperLive:       "paper",
			TenantID:        "tenant-1",
			SandboxID:       "sandbox-1",
		},
		Symbol:        "AAPL",
		Side:          "sell",
		RequestedQty:  5,
		FilledQty:     3,
		FillWatermark: 3,
		Lifecycle:     "partially_filled",
	}
	if err := storage.SaveManagedOrder(order); err != nil {
		t.Fatal(err)
	}

	repeated := *order
	repeated.FilledQty = 1
	repeated.FillWatermark = 1
	if err := storage.SaveManagedOrder(&repeated); err != nil {
		t.Fatal(err)
	}
	fresh, err := storage.GetManagedOrder(order.ClientOrderID)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.FilledQty != 3 || fresh.FillWatermark != 3 {
		t.Fatalf("cumulative fill evidence regressed: filled=%v watermark=%v", fresh.FilledQty, fresh.FillWatermark)
	}
}

func TestManagedOrderProjectionRequiresCompleteIdentity(t *testing.T) {
	setManagedIdentity(t, "broker-account-1")
	storage, err := NewLocalStorage(filepath.Join(t.TempDir(), "managed-orders-missing-identity.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	order := &models.DBManagedOrder{
		PositionID:    "position-1",
		Role:          "entry",
		Purpose:       "entry",
		ClientOrderID: "client-entry-identity",
		DurableIdentity: models.DurableIdentity{
			BrokerAccountID: "broker-account-1",
			PaperLive:       "paper",
			TenantID:        "tenant-1",
		},
		Symbol:       "AAPL",
		Side:         "buy",
		RequestedQty: 1,
		Lifecycle:    "planned",
	}
	if err := storage.SaveManagedOrder(order); err == nil {
		t.Fatal("managed order with incomplete durable identity should be rejected")
	}
}

func TestManagedOrderReadRejectsMismatchedRuntimeIdentity(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "managed-orders-read-identity.db")
	setManagedIdentity(t, "broker-account-1")
	storage, err := NewLocalStorage(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	order := &models.DBManagedOrder{
		PositionID: "position-1", Role: "entry", Purpose: "entry", ClientOrderID: "client-read-identity",
		DurableIdentity: models.DurableIdentity{BrokerAccountID: "broker-account-1", PaperLive: "paper", TenantID: "tenant-1", SandboxID: "sandbox-1"},
		Symbol:          "AAPL", Side: "buy", RequestedQty: 1, Lifecycle: "planned",
	}
	if err := storage.SaveManagedOrder(order); err != nil {
		storage.Close()
		t.Fatal(err)
	}
	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	setManagedIdentity(t, "broker-account-2")
	other, err := NewLocalStorage(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if _, err := other.GetManagedOrder(order.ClientOrderID); err == nil {
		t.Fatal("managed-order read should reject a mismatched runtime identity")
	}
}

func TestSaveManagedPositionRejectsStaleRevision(t *testing.T) {
	storage, err := NewLocalStorage(filepath.Join(t.TempDir(), "positions.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	position := &models.DBManagedPosition{PositionID: "managed-1", Symbol: "AAPL", Side: "buy", Status: "ACTIVE", EntryClientOrderID: "entry-1"}
	if err := storage.SaveManagedPosition(position); err != nil {
		t.Fatal(err)
	}
	stale := *position
	position.Status = "CLOSED"
	position.ExitClientOrderID = "exit-1"
	if err := storage.SaveManagedPosition(position); err != nil {
		t.Fatal(err)
	}
	stale.Status = "ACTIVE"
	if err := storage.SaveManagedPosition(&stale); err == nil {
		t.Fatal("stale managed-position update should be rejected")
	}
	stored, err := storage.GetManagedPosition(position.PositionID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != "CLOSED" || stored.ExitClientOrderID != "exit-1" {
		t.Fatalf("stored position regressed: %#v", stored)
	}
}

func TestSavePositionAllowsMultipleSnapshotsForSameSymbol(t *testing.T) {
	setManagedIdentity(t, "broker-account-1")
	storage, err := NewLocalStorage(filepath.Join(t.TempDir(), "positions.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()
	position := &interfaces.Position{Symbol: "SPY", Qty: 1, CurrentPrice: 500}
	if err := storage.SavePosition(position); err != nil {
		t.Fatal(err)
	}
	position.CurrentPrice = 501
	if err := storage.SavePosition(position); err != nil {
		t.Fatalf("second snapshot should be accepted: %v", err)
	}
	var count int64
	if err := storage.db.Table("positions").Where("symbol = ?", "SPY").Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("expected two snapshots, got %d", count)
	}
}
