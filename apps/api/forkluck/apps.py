from django.apps import AppConfig
from django.contrib.admin import apps as admin_apps


class ForkluckAdminConfig(admin_apps.AdminConfig):
    default = False
    default_site = "forkluck.mommy.MommyAdminSite"


class ForkluckConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "forkluck"
