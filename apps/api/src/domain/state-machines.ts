export type RideStatus =
  | "searching" | "driver_assigned" | "driver_arriving" | "driver_arrived"
  | "in_progress" | "completed" | "cancelled_by_customer"
  | "cancelled_by_driver" | "cancelled_by_platform" | "no_driver_found";

export type FoodOrderStatus =
  | "submitted" | "accepted" | "preparing" | "ready_for_pickup"
  | "courier_assigned" | "picked_up" | "delivered" | "rejected"
  | "cancelled" | "delivery_failed";

const rideTransitions: Record<RideStatus, readonly RideStatus[]> = {
  searching: ["driver_assigned", "cancelled_by_customer", "cancelled_by_platform", "no_driver_found"],
  driver_assigned: ["driver_arriving", "cancelled_by_customer", "cancelled_by_driver", "cancelled_by_platform"],
  driver_arriving: ["driver_arrived", "cancelled_by_customer", "cancelled_by_driver", "cancelled_by_platform"],
  driver_arrived: ["in_progress", "cancelled_by_customer", "cancelled_by_driver", "cancelled_by_platform"],
  in_progress: ["completed", "cancelled_by_platform"],
  completed: [],
  cancelled_by_customer: [],
  cancelled_by_driver: [],
  cancelled_by_platform: [],
  no_driver_found: [],
};

const foodTransitions: Record<FoodOrderStatus, readonly FoodOrderStatus[]> = {
  submitted: ["accepted", "rejected", "cancelled"],
  accepted: ["preparing", "rejected", "cancelled"],
  preparing: ["ready_for_pickup", "cancelled"],
  ready_for_pickup: ["courier_assigned", "cancelled"],
  courier_assigned: ["picked_up", "cancelled", "delivery_failed"],
  picked_up: ["delivered", "delivery_failed"],
  delivered: [],
  rejected: [],
  cancelled: [],
  delivery_failed: [],
};

export function canTransitionRide(from: RideStatus, to: RideStatus): boolean {
  return rideTransitions[from].includes(to);
}

export function canTransitionFoodOrder(from: FoodOrderStatus, to: FoodOrderStatus): boolean {
  return foodTransitions[from].includes(to);
}

export function assertRideTransition(from: RideStatus, to: RideStatus): void {
  if (!canTransitionRide(from, to)) throw new Error(`Invalid ride transition: ${from} -> ${to}`);
}

export function assertFoodOrderTransition(from: FoodOrderStatus, to: FoodOrderStatus): void {
  if (!canTransitionFoodOrder(from, to)) throw new Error(`Invalid food order transition: ${from} -> ${to}`);
}
