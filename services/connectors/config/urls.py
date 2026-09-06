from django.urls import path

from connectors import views

urlpatterns = [
    path("healthz", views.health),
    path("readyz", views.ready),
    path("metrics", views.metrics),
    path("v1/providers", views.providers),
    path("v1/authorization-sessions", views.create_authorization_session),
    path("authorize/<uuid:session_id>", views.authorize),
    path("v1/authorization-codes/exchange", views.exchange_code),
    path("v1/connections/<uuid:connection_id>", views.disconnect),
    path("v1/runs", views.create_run),
    path("v1/runs/<uuid:run_id>", views.run_status),
    path("v1/runs/<uuid:run_id>/pages/next", views.next_page),
    path("v1/runs/<uuid:run_id>/pages/<uuid:page_id>/ack", views.ack_page),
]
