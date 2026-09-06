from django.contrib import admin
from django.urls import include, path

from forkluck.verification import admin_login


admin.site.site_header = "Mommy's Kitchen"
admin.site.site_title = "Forkluck Mommy"
admin.site.index_title = "Keep the kitchen in order."

urlpatterns = [
    # Declared before the admin include so it shadows the stock login and
    # adds the emailed-code step.
    path("mommy/login/", admin_login),
    path("mommy/", admin.site.urls),
    path("api/", include("forkluck.public_urls")),
    path("internal/v1/", include("forkluck.internal_urls")),
]
