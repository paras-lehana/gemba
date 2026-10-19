"""Static description of the fictional manufacturer that Gemba watches.

Everything here is invented for the demo: "Meridian Precision Components" makes cylinder heads, crankshafts, gears,
brackets and gear housings for carmakers in Pune and Chakan (India) and Rayong (Thailand). Numbers are plausible orders
of magnitude for a mid-size auto-components supplier, not measurements of any real plant.
"""
from dataclasses import dataclass, field


@dataclass(frozen=True)
class SensorSpec:
    """One measured signal on a machine. Limits follow the machine's own alarm philosophy (alarm, then trip)."""
    key: str            # short id used in APIs and SQL, e.g. "vib"
    label: str          # what a person reads, e.g. "Vibration (RMS)"
    unit: str
    nominal: float      # healthy steady-state value while running
    noise: float        # 1-sigma of measurement noise
    alarm: float        # above this, someone should look
    trip: float         # above this, the machine protects itself and stops


@dataclass(frozen=True)
class Machine:
    id: str
    name: str
    kind: str                     # VMC, LATHE, GRINDER, HOBBER, FURNACE, COMPRESSOR, PRESS, CASTING, CMM, WASHER, ...
    plant: str
    line: str
    criticality: str              # A (stops the line), B (slows it), C (support)
    cycle_s: float                # ideal cycle time per part, seconds (0 = not a producing machine)
    kw_run: float                 # electrical power while cutting / running
    kw_idle: float                # power while switched on but not producing
    sensors: tuple                # SensorSpec, ...
    pos: tuple                    # (x, z) on the plant floor, metres, used by the 3D twin
    product: str = ""             # product made (producing machines only)


@dataclass(frozen=True)
class Line:
    id: str
    plant: str
    name: str
    product: str
    downtime_cost_per_h: float    # rupees of contribution lost per hour the line is stopped


@dataclass(frozen=True)
class Plant:
    id: str
    name: str
    country: str
    tz: str
    currency: str
    grid_kg_co2_per_kwh: float    # grid emission factor used for Scope 2 estimates (see docs/research)
    tariff: dict = field(default_factory=dict)   # rupee (or baht) per kWh by band


def _vib(nominal, noise=0.12, alarm=4.5, trip=7.1):
    # Alarm 4.5 mm/s is the ISO 10816-3 style C/D boundary for a medium machine on a rigid foundation (zones in analytics).
    return SensorSpec("vib", "Vibration (RMS)", "mm/s", nominal, noise, alarm, trip)


def _temp(nominal, alarm, trip, label="Bearing temperature", noise=0.35):
    return SensorSpec("temp", label, "°C", nominal, noise, alarm, trip)


def _amps(nominal, alarm, trip, noise=0.4):
    return SensorSpec("amps", "Motor current", "A", nominal, noise, alarm, trip)


def _rpm(nominal):
    return SensorSpec("rpm", "Spindle speed", "rpm", nominal, nominal * 0.002, nominal * 1.1, nominal * 1.2)


# Money is in US dollars everywhere (judges are across JAPAC). Converted at FX_INR = 88 rupees and FX_THB = 33 baht per dollar.
FX_INR, FX_THB = 88.0, 33.0
TARIFF_IN = {"peak": round(9.8 / FX_INR, 4), "normal": round(7.6 / FX_INR, 4), "offpeak": round(5.9 / FX_INR, 4)}  # Maharashtra-style ToD bands
TARIFF_TH = {"peak": round(4.2 / FX_THB, 4), "normal": round(3.6 / FX_THB, 4), "offpeak": round(2.6 / FX_THB, 4)}  # Thai TOU-style (approximate)

PLANTS = {
    "PUN": Plant("PUN", "Pune Plant", "India", "Asia/Kolkata", "USD", 0.71, TARIFF_IN),
    "CHK": Plant("CHK", "Chakan Plant", "India", "Asia/Kolkata", "USD", 0.71, TARIFF_IN),
    "RAY": Plant("RAY", "Rayong Plant", "Thailand", "Asia/Bangkok", "USD", 0.40, TARIFF_TH),
}

LINES = {
    "PUN-L1": Line("PUN-L1", "PUN", "Cylinder Head Line", "CH-15", 545),
    "PUN-L2": Line("PUN-L2", "PUN", "Crankshaft Line", "CRK-T4", 466),
    "PUN-L3": Line("PUN-L3", "PUN", "Gear Line", "GR-6", 409),
    "PUN-UT": Line("PUN-UT", "PUN", "Utilities", "", 0),
    "CHK-L1": Line("CHK-L1", "CHK", "Bracket Line", "BRK-22", 250),
    "CHK-UT": Line("CHK-UT", "CHK", "Utilities", "", 0),
    "RAY-L1": Line("RAY-L1", "RAY", "Gear Housing Line", "GH-7", 341),
    "RAY-UT": Line("RAY-UT", "RAY", "Utilities", "", 0),
}


def _vmc(mid, plant, line, x, z, product):
    return Machine(mid, "Vertical machining centre", "VMC", plant, line, "A", 210, 18.0, 4.5,
                   (_vib(1.6), _temp(48, 75, 85), _amps(28, 40, 46), _rpm(12000)), (x, z), product)


def _machines():
    m = []
    # Pune, Cylinder Head Line: four VMC cells in parallel, then CMM and washer. VMC-204 is the hero machine.
    for i, x in enumerate((-12, -6, 0, 6), start=1):
        m.append(_vmc(f"VMC-20{i}", "PUN", "PUN-L1", x, -10, "CH-15"))
    m.append(Machine("CMM-201", "Coordinate measuring machine", "CMM", "PUN", "PUN-L1", "B", 0, 3.0, 1.5,
                     (_temp(21, 24, 26, "Room temperature", 0.1),), (12, -10)))
    m.append(Machine("WSH-201", "Parts washer", "WASHER", "PUN", "PUN-L1", "C", 0, 22.0, 6.0,
                     (_temp(60, 72, 80, "Wash temperature", 0.4),), (18, -10)))
    # Pune, Crankshaft Line.
    for i, x in enumerate((-12, -6), start=1):
        m.append(Machine(f"LTH-10{i}", "CNC turning centre", "LATHE", "PUN", "PUN-L2", "A", 150, 22.0, 5.0,
                         (_vib(1.8, 0.14), _temp(50, 75, 85), _amps(35, 50, 56), _rpm(3000)), (x, 0), "CRK-T4"))
    for i, x in enumerate((0, 6), start=1):
        m.append(Machine(f"GRD-10{i}", "Crankpin grinder", "GRINDER", "PUN", "PUN-L2", "A", 160, 26.0, 7.0,
                         (_vib(1.0, 0.08, 2.8, 4.5), _temp(42, 65, 75), _amps(40, 55, 62), _rpm(1800)), (x, 0), "CRK-T4"))
    m.append(Machine("BAL-101", "Balancing machine", "BALANCER", "PUN", "PUN-L2", "B", 0, 6.0, 2.0,
                     (_vib(0.8, 0.06, 2.8, 4.5),), (12, 0)))
    # Pune, Gear Line.
    for i, x in enumerate((-12, -6), start=1):
        m.append(Machine(f"HOB-30{i}", "Gear hobbing machine", "HOBBER", "PUN", "PUN-L3", "A", 95, 15.0, 4.0,
                         (_vib(2.0, 0.15), _temp(46, 70, 80), _amps(24, 34, 40), _rpm(900)), (x, 10), "GR-6"))
    m.append(Machine("SHP-301", "Gear shaper", "SHAPER", "PUN", "PUN-L3", "B", 110, 12.0, 3.5,
                     (_vib(1.9, 0.15), _temp(45, 70, 80), _amps(20, 30, 35)), (0, 10), "GR-6"))
    m.append(Machine("HTF-301", "Heat-treatment furnace", "FURNACE", "PUN", "PUN-L3", "A", 0, 120.0, 45.0,
                     (_temp(860, 900, 930, "Furnace temperature", 1.5),), (7, 10)))
    m.append(Machine("DEB-301", "Deburring cell", "DEBURR", "PUN", "PUN-L3", "C", 0, 8.0, 2.0,
                     (_vib(1.2, 0.1),), (13, 10)))
    # Pune utilities: the compressor carries the night-time air-leak scenario.
    m.append(Machine("CMP-901", "Air compressor 45 kW", "COMPRESSOR", "PUN", "PUN-UT", "B", 0, 45.0, 12.0,
                     (SensorSpec("press", "Header pressure", "bar", 7.0, 0.05, 6.2, 5.8), _temp(78, 95, 105, "Oil temperature")),
                     (-12, 20)))
    m.append(Machine("CHL-902", "Process chiller", "CHILLER", "PUN", "PUN-UT", "C", 0, 30.0, 8.0,
                     (_temp(14, 18, 22, "Supply water temperature", 0.15),), (-4, 20)))
    # Chakan, Bracket Line (the plant with two spare spindle bearings).
    for i, x in enumerate((-8, -2), start=1):
        m.append(Machine(f"PRS-40{i}", "Servo press 400 t", "PRESS", "CHK", "CHK-L1", "A", 12, 55.0, 9.0,
                         (_vib(2.4, 0.18, 5.0, 8.0), _temp(52, 75, 85, "Oil temperature"), _amps(70, 95, 110)), (x, 0), "BRK-22"))
    m.append(Machine("WLD-401", "Robotic weld cell", "WELDER", "CHK", "CHK-L1", "B", 45, 20.0, 3.0,
                     (_amps(120, 160, 180, 1.5),), (4, 0), "BRK-22"))
    for i, x in enumerate((10, 16), start=1):
        m.append(_vmc(f"VMC-41{i}", "CHK", "CHK-L1", x, 0, "BRK-22"))
    m.append(Machine("CMP-951", "Air compressor 30 kW", "COMPRESSOR", "CHK", "CHK-UT", "B", 0, 30.0, 8.0,
                     (SensorSpec("press", "Header pressure", "bar", 7.0, 0.05, 6.2, 5.8),), (-8, 10)))
    # Rayong, Gear Housing Line (aluminium castings; carries the supplier-lot porosity scenario).
    for i, x in enumerate((-10, -4), start=1):
        m.append(Machine(f"DIE-50{i}", "High-pressure die casting cell", "CASTING", "RAY", "RAY-L1", "A", 70, 85.0, 30.0,
                         (_temp(680, 710, 730, "Melt temperature", 2.0), SensorSpec("press", "Shot pressure", "bar", 520, 6, 470, 440)),
                         (x, 0), "GH-7"))
    for i, x in enumerate((2, 8), start=1):
        m.append(_vmc(f"VMC-51{i}", "RAY", "RAY-L1", x, 0, "GH-7"))
    m.append(Machine("LKT-501", "Leak tester", "LEAKTEST", "RAY", "RAY-L1", "B", 0, 4.0, 1.5,
                     (SensorSpec("leak", "Leak rate", "ml/min", 1.2, 0.15, 3.0, 5.0),), (14, 0)))
    m.append(Machine("CMP-991", "Air compressor 37 kW", "COMPRESSOR", "RAY", "RAY-UT", "B", 0, 37.0, 10.0,
                     (SensorSpec("press", "Header pressure", "bar", 7.0, 0.05, 6.2, 5.8),), (-10, 10)))
    return {x.id: x for x in m}


MACHINES = _machines()

PRODUCTS = {
    "CH-15": {"name": "Cylinder head 1.5 L", "price": 70, "plant": "PUN", "line": "PUN-L1"},
    "CRK-T4": {"name": "Crankshaft T4", "price": 61, "plant": "PUN", "line": "PUN-L2"},
    "GR-6": {"name": "Gear set 6-speed", "price": 35, "plant": "PUN", "line": "PUN-L3"},
    "BRK-22": {"name": "Suspension bracket", "price": 7.3, "plant": "CHK", "line": "CHK-L1"},
    "GH-7": {"name": "Gear housing", "price": 44, "plant": "RAY", "line": "RAY-L1"},
}

# Fictional customers. Names are invented; any resemblance to real companies is unintended.
CUSTOMERS = {
    "DDM": "Deccan Drive Motors",
    "AEV": "Andaman EV Co.",
    "NTR": "Narmada Tractors",
    "MKM": "Mekong Mobility",
}

# Spare parts that matter in the scenarios: stock by plant and transfer time to Pune.
SPARES = {
    "SPB-7014": {"name": "Spindle bearing set 7014 (VMC)", "price": 545, "fits": "VMC",
                 "stock": {"PUN": 0, "CHK": 2, "RAY": 1}, "transfer_h": {"CHK": 9, "RAY": 72}},
    "INS-CNMG": {"name": "Turning insert CNMG (box of 10)", "price": 36, "fits": "LATHE",
                 "stock": {"PUN": 14, "CHK": 0, "RAY": 6}, "transfer_h": {}},
    "FLT-AIR": {"name": "Compressor intake filter", "price": 74, "fits": "COMPRESSOR",
                "stock": {"PUN": 2, "CHK": 1, "RAY": 1}, "transfer_h": {}},
}

TECHNICIANS = [
    {"id": "T-PUN-01", "name": "Ravi Kulkarni", "plant": "PUN", "skills": ["spindle", "bearing", "VMC"], "shift": "A", "lang": "hi"},
    {"id": "T-PUN-02", "name": "Sunita Pawar", "plant": "PUN", "skills": ["electrical", "compressor", "VMC"], "shift": "C", "lang": "mr"},
    {"id": "T-PUN-03", "name": "Imran Shaikh", "plant": "PUN", "skills": ["grinder", "lathe", "hydraulics"], "shift": "B", "lang": "hi"},
    {"id": "T-RAY-01", "name": "Somchai Wongsa", "plant": "RAY", "skills": ["casting", "VMC", "leak test"], "shift": "A", "lang": "th"},
    {"id": "T-CHK-01", "name": "Anil Deshmukh", "plant": "CHK", "skills": ["press", "welding", "VMC"], "shift": "A", "lang": "mr"},
]

# Time-of-day tariff bands (local time). Off-peak 22:00-06:00, peak 09:00-12:00 and 18:00-22:00, normal otherwise.
def tariff_band(hour: int) -> str:
    if hour >= 22 or hour < 6:
        return "offpeak"
    if 9 <= hour < 12 or 18 <= hour < 22:
        return "peak"
    return "normal"
