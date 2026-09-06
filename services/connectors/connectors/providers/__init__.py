from .baldor import BaldorClient

PROVIDERS = {
    "baldor": {
        "key": "baldor",
        "displayName": "Baldor",
        "description": "Import invoices and credits from your Baldor account.",
        "icon": "",
        "capabilities": ["invoices", "credits"],
        "available": True,
        "client": BaldorClient,
    },
}
