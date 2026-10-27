import json
import math
import uuid
from decimal import Decimal
from pathlib import Path


class BudgetError(RuntimeError):
    pass


class VoiceBudget:
    def __init__(self, config, state_path=None):
        self.config = config
        self.limit = Decimal(config.get("totalBudgetCny", "100"))
        self.usd_cny_rate = Decimal(config["usdCnyRate"])
        self.state_path = Path(state_path) if state_path else None
        self.spent = Decimal("0")
        self.reserved = Decimal("0")
        self.reservations = {}

    @property
    def remaining(self):
        return self.limit - self.spent - self.reserved

    def price(self, provider, operation):
        entry = self.config["providers"][provider][operation]
        if entry.get("unitPriceCny") is not None:
            return Decimal(entry["unitPriceCny"]), entry["unit"]
        if entry.get("unitPriceUsd") is not None:
            return Decimal(entry["unitPriceUsd"]) * self.usd_cny_rate, entry["unit"]
        raise BudgetError(
            f"{provider}/{operation} has no verified price; fill the current console price before --execute"
        )

    def estimate(self, provider, operation, quantity):
        unit_price, unit = self.price(provider, operation)
        units = math.ceil(quantity) if unit == "seconds" else int(quantity)
        if units < 0:
            raise BudgetError("negative usage is invalid")
        return unit_price * Decimal(units)

    def reserve(self, provider, operation, quantity):
        cost = self.estimate(provider, operation, quantity)
        if cost > self.remaining:
            raise BudgetError(
                f"voice budget exhausted: need {cost:.6f} CNY, remaining {self.remaining:.6f} CNY"
            )
        reservation_id = uuid.uuid4().hex
        self.reserved += cost
        self.reservations[reservation_id] = {
            "provider": provider,
            "operation": operation,
            "reservedCny": str(cost),
        }
        self._persist("reserved", reservation_id)
        return reservation_id

    def settle(self, reservation_id, actual_quantity=None, quality="reported"):
        reservation = self.reservations.pop(reservation_id, None)
        if reservation is None:
            raise BudgetError(f"unknown or already settled reservation: {reservation_id}")
        reserved = Decimal(reservation["reservedCny"])
        self.reserved -= reserved
        if actual_quantity is None:
            actual = reserved
            quality = "conservative-full-reservation"
        else:
            actual = self.estimate(
                reservation["provider"], reservation["operation"], actual_quantity
            )
        self.spent += actual
        if self.spent > self.limit:
            raise BudgetError("actual provider usage exceeded the 100 CNY hard cap; stop all further calls")
        self._persist("settled", reservation_id, actual, quality)
        return actual

    def summary(self):
        return {
            "currency": "CNY",
            "limit": str(self.limit),
            "spent": str(self.spent),
            "reserved": str(self.reserved),
            "remaining": str(self.remaining),
            "separateFromClaudeAndCodex": True,
        }

    def _persist(self, action, reservation_id, actual=None, quality=None):
        if not self.state_path:
            return
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "action": action,
            "reservationId": reservation_id,
            "actualCny": str(actual) if actual is not None else None,
            "quality": quality,
            "summary": self.summary(),
        }
        with self.state_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
